/**
 * fastEditAudio.mjs — Pipeline âm thanh Fast Edit 3 giai đoạn tối ưu cho Laptop Văn Phòng.
 *
 *  A. cleanAudio     : Khử ồn toàn track 1 lần -> clean.wav (PCM s16le 48k, cache LRU, tiết kiệm 50% đĩa)
 *  B. cutClip        : Snap keyframe, cắt video copy, cắt audio WAV theo đúng độ dài video thực tế + micro-fade
 *  C. exportTimeline : Nối video + nối PCM, loudnorm 2 pass, AAC 1 lần, ghi nguyên tử (.part), kiểm tra lệch A/V
 *
 *  Tối ưu phần cứng Laptop:
 *  - Giới hạn Threads theo nhân thực: Math.min(4, Math.max(1, Math.floor(os.cpus().length / 2)))
 *  - Hạ mức ưu tiên tiến trình: PRIORITY_BELOW_NORMAL (không đơ chuột, không nghẽn OS)
 *  - Ghi nguyên tử Atomic Rename kèm Retry chống xung đột Windows Defender
 *  - Tự động dọn dẹp bộ nhớ đệm (LRU Cache Eviction <= 2GB) và kiểm tra dung lượng trống SSD
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOCAL_FFMPEG = fs.existsSync(path.join(__dirname, 'runtime', 'ffmpeg.exe'))
  ? path.join(__dirname, 'runtime', 'ffmpeg.exe')
  : 'ffmpeg';

const LOCAL_FFPROBE = fs.existsSync(path.join(__dirname, 'runtime', 'ffprobe.exe'))
  ? path.join(__dirname, 'runtime', 'ffprobe.exe')
  : 'ffprobe';

// Cố định số luồng theo nhân vật lý (tránh thermal throttling trên CPU dòng U)
export const RECOMMENDED_THREADS = Math.min(4, Math.max(1, Math.floor((os.cpus() || []).length / 2)));

export const DEFAULTS = {
  ffmpeg: LOCAL_FFMPEG,
  ffprobe: LOCAL_FFPROBE,
  fadeMs: 10,
  targetI: -16,
  targetTP: -1.5,
  targetLRA: 11,
  aacBitrate: '192k',
  maxDriftFrames: 1, // chênh lệch A/V cho phép (tính theo số frame)
  threads: RECOMMENDED_THREADS,
};

/* ---------- Tiện ích Điều tiết CPU & File I/O ---------- */

export function run(bin, args, opts = {}) {
  const { signal, timeout = 600000, ...spawnOpts } = opts;
  return new Promise((resolve, reject) => {
    const isFFmpeg = path.basename(bin).toLowerCase().includes('ffmpeg');
    const finalArgs = [...args];
    if (isFFmpeg && !finalArgs.includes('-threads')) {
      finalArgs.unshift('-threads', String(RECOMMENDED_THREADS));
    }

    const p = spawn(bin, finalArgs, { windowsHide: true, ...spawnOpts });

    // Hạ mức ưu tiên xuống BELOW_NORMAL để giữ giao diện Windows luôn mượt mà
    try {
      if (p.pid && os.constants.priority?.PRIORITY_BELOW_NORMAL) {
        os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
      }
    } catch {}

    const MAX_STDOUT = 8 * 1024 * 1024;
    const MAX_STDERR = 256 * 1024;
    let out = '', err = '';
    let stdoutOverflow = false;
    let aborted = false;
    let timer = null;

    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (signal) { signal.removeEventListener('abort', onAbort); }
    };

    const killProc = () => {
      if (!p || !p.pid) return;
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true });
        } else {
          p.kill('SIGKILL');
        }
      } catch {}
    };

    const onAbort = () => {
      aborted = true;
      cleanup();
      killProc();
      reject(new Error('Thao tác âm thanh đã bị dừng lại.'));
    };

    if (signal) {
      if (signal.aborted) {
        killProc();
        return reject(new Error('Thao tác âm thanh đã bị dừng lại.'));
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    if (timeout > 0) {
      timer = setTimeout(() => {
        aborted = true;
        cleanup();
        killProc();
        reject(new Error(`Tác vụ ${path.basename(bin)} vượt quá thời gian tối đa ${Math.round(timeout / 1000)}s`));
      }, timeout);
    }

    p.stdout?.on('data', d => {
      const text = d.toString();
      if (out.length + text.length > MAX_STDOUT) {
        stdoutOverflow = true;
      } else {
        out += text;
      }
    });

    p.stderr?.on('data', d => {
      const text = d.toString();
      err = (err + text).slice(-MAX_STDERR);
    });

    p.on('error', (e) => {
      cleanup();
      if (!aborted) reject(e);
    });

    p.on('close', code => {
      cleanup();
      if (aborted || signal?.aborted) {
        return reject(new Error('Thao tác âm thanh đã bị dừng lại.'));
      }
      if (stdoutOverflow) {
        return reject(new Error('Đầu ra tiến trình vượt giới hạn bộ nhớ an toàn (8 MB).'));
      }
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(new Error(`${path.basename(bin)} exit ${code}\n${err.slice(-1500)}`));
    });
  });
}

/** Ghi nguyên tử kèm cơ chế retry chống xung đột file lock của Windows / Antivirus */
export async function atomicRename(tempPath, destPath, retries = 5, delayMs = 150) {
  for (let i = 0; i < retries; i++) {
    try {
      if (fs.existsSync(destPath)) {
        try { fs.unlinkSync(destPath); } catch {}
      }
      fs.renameSync(tempPath, destPath);
      return;
    } catch (err) {
      if ((err.code === 'EBUSY' || err.code === 'EPERM') && i < retries - 1) {
        await new Promise(r => setTimeout(r, delayMs * (i + 1)));
      } else {
        throw err;
      }
    }
  }
}

/** Kiểm tra dung lượng trống của ổ cứng trước khi bắt đầu xử lý */
export function checkFreeDiskSpace(targetDir, minBytes = 1024 * 1024 * 1024) {
  try {
    if (typeof fs.statfsSync === 'function') {
      const stats = fs.statfsSync(targetDir);
      const freeBytes = Number(stats.bavail) * Number(stats.bsize);
      if (freeBytes < minBytes) {
        const freeMB = Math.round(freeBytes / (1024 * 1024));
        throw new Error(`Ổ đĩa còn quá ít dung lượng trống (${freeMB} MB). Cần tối thiểu 1 GB để xử lý video an toàn.`);
      }
    }
  } catch (err) {
    if (err.message.includes('Ổ đĩa còn quá ít')) throw err;
  }
}

/** Quản lý thu dọn Cache theo thuật toán LRU (giữ tối đa 2 file và không quá 2GB) */
export function pruneAudioCache(cacheDir, maxFiles = 2, maxSizeBytes = 2 * 1024 * 1024 * 1024) {
  try {
    if (!fs.existsSync(cacheDir)) return;
    const now = Date.now();

    // Dọn dẹp các file rác dở dang .part.wav tồn tại quá 15 phút
    const parts = fs.readdirSync(cacheDir).filter(f => f.includes('.part.'));
    for (const p of parts) {
      try {
        const fp = path.join(cacheDir, p);
        if (now - fs.statSync(fp).mtimeMs > 15 * 60 * 1000) fs.unlinkSync(fp);
      } catch {}
    }

    const files = fs.readdirSync(cacheDir)
      .filter(f => f.startsWith('clean_') && f.endsWith('.wav'))
      .map(f => {
        const fp = path.join(cacheDir, f);
        try {
          const st = fs.statSync(fp);
          return { path: fp, size: st.size, atime: st.atimeMs || st.mtimeMs };
        } catch { return null; }
      })
      .filter(Boolean);

    // Sắp xếp LRU: file cũ nhất lên đầu
    files.sort((a, b) => a.atime - b.atime);

    let totalSize = files.reduce((sum, f) => sum + f.size, 0);
    while (files.length > maxFiles || totalSize > maxSizeBytes) {
      const victim = files.shift();
      if (!victim) break;
      try {
        fs.unlinkSync(victim.path);
        totalSize -= victim.size;
      } catch {}
    }
  } catch {}
}

export const fwd = p => p.replace(/\\/g, '/');
export const fmt = n => Number(n).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');

export function parseRate(s) {
  const [a, b] = String(s || '0/1').split('/').map(Number);
  return b ? a / b : a || 0;
}

export async function probeJson(opts, args) {
  const { stdout } = await run(opts.ffprobe || DEFAULTS.ffprobe, ['-v', 'error', '-of', 'json', ...args]);
  return JSON.parse(stdout);
}

/* ---------- Chọn stream audio chính ---------- */

export async function pickAudioStream(src, o = DEFAULTS) {
  const j = await probeJson(o, ['-select_streams', 'a', '-show_streams', src]);
  const a = j.streams || [];
  if (!a.length) return null;
  const score = s => (s.disposition?.default ? 1000 : 0) + (s.channels || 0) * 10 + Number(s.bit_rate || 0) / 1e6;
  let best = 0;
  a.forEach((s, i) => { if (score(s) > score(a[best])) best = i; });
  return { index: best, channels: a[best].channels || 2 };
}

/* ---------- Giai đoạn A: Khử ồn & Chuẩn hóa (PCM 16-bit tiết kiệm 50% đĩa) ---------- */

export async function cleanAudio(src, cacheDir, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  fs.mkdirSync(cacheDir, { recursive: true });
  checkFreeDiskSpace(cacheDir);
  pruneAudioCache(cacheDir);

  const st = fs.statSync(src);
  const key = crypto.createHash('sha1').update(`${path.resolve(src)}|${st.size}|${st.mtimeMs}|v3-s16`).digest('hex').slice(0, 16);
  const out = path.join(cacheDir, `clean_${key}.wav`);
  
  if (fs.existsSync(out) && fs.statSync(out).size > 0) {
    try {
      // Cập nhật atime phục vụ cơ chế LRU
      const now = new Date();
      fs.utimesSync(out, now, now);
    } catch {}
    return out; // cache hit
  }

  const pick = await pickAudioStream(src, o);
  if (!pick) throw new Error('Video không có luồng âm thanh');

  const channels = pick.channels === 1 ? '1' : '2';

  // volume=-3dB bảo vệ mức trần trước khi dither về s16 (Loudnorm Giai đoạn C sẽ đưa về chuẩn -16 LUFS)
  const af = [
    'aresample=async=1:first_pts=0',
    'highpass=f=80:poles=2',
    'afftdn=nr=10:nf=-45:tn=1:gs=5',
    'equalizer=f=3200:t=q:w=1.2:g=2.5',
    'volume=-3dB',
    'aresample=osf=s16:dither_method=triangular'
  ].join(',');

  const tmp = out + `.part_${Date.now()}.wav`;
  await run(o.ffmpeg, [
    '-y', '-hide_banner',
    '-i', src,
    '-vn', '-map', `0:a:${pick.index}`,
    '-af', af,
    '-ar', '48000', '-ac', channels,
    '-c:a', 'pcm_s16le',
    tmp
  ]);

  await atomicRename(tmp, out);
  return out;
}

/* ---------- Dò Keyframe chính xác ---------- */

export async function keyframeAtOrBefore(src, t, o = DEFAULTS) {
  const f = await probeJson(o, ['-show_entries', 'format=start_time', src]);
  const startTime = Number(f.format?.start_time || 0);
  const target = t + startTime;
  for (let span = 15; ; span *= 4) {
    const lo = Math.max(0, target - span);
    const { stdout } = await run(o.ffprobe, ['-v', 'error', '-select_streams', 'v:0',
      '-read_intervals', `${fmt(lo)}%${fmt(target + 0.0005)}`,
      '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', src]);
    const keys = stdout.split(/\r?\n/)
      .map(l => l.split(','))
      .filter(c => c[1] && c[1].includes('K') && c[0] && c[0] !== 'N/A')
      .map(c => Number(c[0]))
      .filter(x => x <= target + 0.0005);
    if (keys.length) return Math.max(...keys) - startTime;
    if (lo === 0) return 0;
  }
}

/* ---------- Giai đoạn B: Cắt Clip Video Stream Copy & Audio Khớp Mẫu ---------- */

export async function cutClip(clip, cleanWav, workDir, index, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if ((clip.mode || 'snap') !== 'snap') throw new Error("Chế độ 'exact' (Smart Cut) chưa được hỗ trợ");
  if (!(clip.end > clip.start)) throw new Error(`Clip ${index}: end phải lớn hơn start`);
  fs.mkdirSync(workDir, { recursive: true });

  const snapped = Math.max(0, await keyframeAtOrBefore(clip.src, clip.start, o));
  const videoOut = path.join(workDir, `clip_${index}.mp4`);
  const audioOut = path.join(workDir, `clip_${index}.wav`);

  // +1 ms để làm tròn số thực không kéo ffmpeg lùi về keyframe trước đó nữa
  await run(o.ffmpeg, [
    '-y', '-hide_banner',
    '-ss', fmt(snapped + 0.001), '-t', fmt(clip.end - snapped),
    '-i', clip.src,
    '-map', '0:v:0', '-an',
    '-c:v', 'copy',
    '-avoid_negative_ts', 'make_zero',
    videoOut
  ]);

  // Đo độ dài thực tế của video làm chuẩn đồng bộ
  const pj = await probeJson(o, ['-show_entries', 'format=duration', videoOut]);
  const dur = Number(pj.format?.duration);
  if (!(dur > 0)) throw new Error(`Clip ${index}: không đo được độ dài video`);

  const fade = Math.min(o.fadeMs / 1000, dur / 2);
  const af = `afade=t=in:d=${fmt(fade)},afade=t=out:st=${fmt(Math.max(0, dur - fade))}:d=${fmt(fade)}`;

  await run(o.ffmpeg, [
    '-y', '-hide_banner',
    '-ss', fmt(snapped), '-t', fmt(dur),
    '-i', cleanWav,
    '-af', af,
    '-c:a', 'pcm_s16le',
    audioOut
  ]);

  return { video: videoOut, audio: audioOut, start: snapped, duration: dur };
}

/* ---------- Giai đoạn C: Concat Demuxer, 2-Pass Loudnorm & Ghi Nguyên Tử ---------- */

export function writeConcatList(file, paths) {
  const body = paths.map(p => `file '${fwd(path.resolve(p)).replace(/'/g, "'\\''")}'`).join('\n');
  fs.writeFileSync(file, body + '\n');
}

export function lastJsonBlock(text) {
  const all = text.match(/\{[^{}]*\}/g);
  if (!all) throw new Error('Không đọc được JSON của loudnorm:\n' + text.slice(-800));
  return JSON.parse(all[all.length - 1]);
}

export async function exportTimeline(clipResults, workDir, finalOut, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const warnings = [];

  checkFreeDiskSpace(path.dirname(finalOut));

  const vList = path.join(workDir, 'concat_v.txt');
  const aList = path.join(workDir, 'concat_a.txt');
  const videoConcat = path.join(workDir, 'video_concat.mp4');
  const timeline = path.join(workDir, 'timeline.wav');

  writeConcatList(vList, clipResults.map(c => c.video));
  writeConcatList(aList, clipResults.map(c => c.audio));

  await run(o.ffmpeg, ['-y', '-hide_banner', '-f', 'concat', '-safe', '0', '-i', vList, '-c', 'copy', videoConcat]);
  await run(o.ffmpeg, ['-y', '-hide_banner', '-f', 'concat', '-safe', '0', '-i', aList, '-c', 'copy', timeline]);

  const ln = `I=${o.targetI}:TP=${o.targetTP}:LRA=${o.targetLRA}`;

  // Pass 1: Đo lường âm lượng
  const p1 = await run(o.ffmpeg, ['-hide_banner', '-i', timeline, '-af', `loudnorm=${ln}:print_format=json`, '-f', 'null', '-']);
  const m = lastJsonBlock(p1.stderr);
  if (m.input_i === '-inf' || m.input_i === '-Infinity') throw new Error('Timeline im lặng hoàn toàn, không thể chuẩn hóa');

  // Pass 2: Áp dụng chuẩn hóa và xuất ra file tạm .part.mp4 (Ghi nguyên tử)
  const af = `loudnorm=${ln}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}` +
    `:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true:print_format=json,aresample=48000`;

  const tempFinal = finalOut + `.part_${Date.now()}.mp4`;

  const p2 = await run(o.ffmpeg, [
    '-y', '-hide_banner',
    '-i', videoConcat,
    '-i', timeline,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy',
    '-af', af,
    '-c:a', 'aac', '-b:a', o.aacBitrate, '-ar', '48000',
    '-movflags', '+faststart',
    tempFinal
  ]);

  let loud = null;
  try {
    loud = lastJsonBlock(p2.stderr);
    if (loud.normalization_type && loud.normalization_type !== 'linear')
      warnings.push(`loudnorm rơi về chế độ ${loud.normalization_type} (LRA đo được ${m.input_lra}, TP đo được ${m.input_tp})`);
    if (Math.abs(Number(loud.output_i) - o.targetI) > 1.5)
      warnings.push(`Âm lượng đầu ra ${loud.output_i} LUFS lệch mục tiêu ${o.targetI}`);
  } catch (e) { warnings.push('Không đọc được thống kê loudnorm pass 2'); }

  // Ghi nguyên tử sang file đích
  await atomicRename(tempFinal, finalOut);

  // Thu dọn các phân đoạn clip trung gian ngay lập tức để giải phóng đĩa
  for (const c of clipResults) {
    try { if (fs.existsSync(c.video)) fs.unlinkSync(c.video); } catch {}
    try { if (fs.existsSync(c.audio)) fs.unlinkSync(c.audio); } catch {}
  }
  try { if (fs.existsSync(videoConcat)) fs.unlinkSync(videoConcat); } catch {}
  try { if (fs.existsSync(timeline)) fs.unlinkSync(timeline); } catch {}
  try { if (fs.existsSync(vList)) fs.unlinkSync(vList); } catch {}
  try { if (fs.existsSync(aList)) fs.unlinkSync(aList); } catch {}

  const sync = await verifySync(finalOut, o);
  if (!sync.ok) warnings.push(`Lệch A/V ${(sync.diff * 1000).toFixed(1)} ms (> ${o.maxDriftFrames} frame)`);

  return { output: finalOut, measured: m, loudnormOut: loud, sync, warnings };
}

export async function verifySync(file, o = DEFAULTS) {
  const j = await probeJson(o, ['-show_entries', 'stream=codec_type,duration,avg_frame_rate', file]);
  const v = j.streams?.find(s => s.codec_type === 'video');
  const a = j.streams?.find(s => s.codec_type === 'audio');
  if (!v || !a) return { ok: false, diff: NaN, video: null, audio: null };
  const frame = 1 / (parseRate(v.avg_frame_rate) || 30);
  const diff = Math.abs(Number(a.duration) - Number(v.duration));
  return { ok: diff <= frame * o.maxDriftFrames, diff, video: Number(v.duration), audio: Number(a.duration), frame };
}

/* ---------- Điểm vào tổng ---------- */

export async function buildLesson(clips, workDir, finalOut, opts = {}) {
  if (!clips.length) throw new Error('Timeline rỗng');
  const cacheDir = path.join(workDir, 'cache');
  const cleanBySrc = new Map();
  const results = [];
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    if (!cleanBySrc.has(c.src)) cleanBySrc.set(c.src, await cleanAudio(c.src, cacheDir, opts));
    results.push(await cutClip(c, cleanBySrc.get(c.src), workDir, i, opts));
  }
  return exportTimeline(results, workDir, finalOut, opts);
}
