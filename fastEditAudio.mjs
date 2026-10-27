/**
 * fastEditAudio.mjs — Pipeline âm thanh Fast Edit 3 giai đoạn (Chuẩn hóa ES Module).
 *
 *  A. cleanAudio : khử ồn toàn track 1 lần  -> clean.wav (PCM f32le 48k stereo, cache theo nguồn)
 *  B. cutClip    : snap keyframe, cắt video copy, cắt audio WAV theo đúng độ dài video thực tế + micro-fade
 *  C. exportTimeline : nối video + nối PCM, loudnorm 2 pass, AAC một lần, kiểm tra lệch A/V
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOCAL_FFMPEG = fs.existsSync(path.join(__dirname, 'runtime', 'ffmpeg.exe'))
  ? path.join(__dirname, 'runtime', 'ffmpeg.exe')
  : 'ffmpeg';

const LOCAL_FFPROBE = fs.existsSync(path.join(__dirname, 'runtime', 'ffprobe.exe'))
  ? path.join(__dirname, 'runtime', 'ffprobe.exe')
  : 'ffprobe';

export const DEFAULTS = {
  ffmpeg: LOCAL_FFMPEG,
  ffprobe: LOCAL_FFPROBE,
  fadeMs: 10,
  targetI: -16,
  targetTP: -1.5,
  targetLRA: 11,
  aacBitrate: '192k',
  maxDriftFrames: 1, // chênh lệch A/V cho phép (tính theo số frame)
};

/* ---------- tiện ích ---------- */

export function run(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('error', reject);
    p.on('close', code => {
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(new Error(`${path.basename(bin)} exit ${code}\n${err.slice(-1500)}`));
    });
  });
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

/* ---------- chọn stream audio chính ---------- */

export async function pickAudioStream(src, o = DEFAULTS) {
  const j = await probeJson(o, ['-select_streams', 'a', '-show_streams', src]);
  const a = j.streams || [];
  if (!a.length) return null;
  const score = s => (s.disposition?.default ? 1000 : 0) + (s.channels || 0) * 10 + Number(s.bit_rate || 0) / 1e6;
  let best = 0;
  a.forEach((s, i) => { if (score(s) > score(a[best])) best = i; });
  return { index: best, channels: a[best].channels };
}

/* ---------- Giai đoạn A ---------- */

export async function cleanAudio(src, cacheDir, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  fs.mkdirSync(cacheDir, { recursive: true });
  const st = fs.statSync(src);
  const key = crypto.createHash('sha1').update(`${path.resolve(src)}|${st.size}|${st.mtimeMs}|v3`).digest('hex').slice(0, 16);
  const out = path.join(cacheDir, `clean_${key}.wav`);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return out; // cache hit

  const pick = await pickAudioStream(src, o);
  if (!pick) throw new Error('Video không có luồng âm thanh');

  const af = [
    'aresample=async=1:first_pts=0',
    'highpass=f=80:poles=2',
    'afftdn=nr=10:nf=-45:tn=1:gs=5',
    'equalizer=f=3200:t=q:w=1.2:g=2.5',
  ].join(',');

  const tmp = out + '.part.wav';
  await run(o.ffmpeg, ['-y', '-hide_banner', '-i', src, '-vn', '-map', `0:a:${pick.index}`,
    '-af', af, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_f32le', tmp]);
  fs.renameSync(tmp, out); // ghi nguyên tử, tránh cache dở dang
  return out;
}

/* ---------- Keyframe ---------- */

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

/* ---------- Giai đoạn B ---------- */

export async function cutClip(clip, cleanWav, workDir, index, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if ((clip.mode || 'snap') !== 'snap') throw new Error("Chế độ 'exact' (Smart Cut) chưa được hỗ trợ");
  if (!(clip.end > clip.start)) throw new Error(`Clip ${index}: end phải lớn hơn start`);
  fs.mkdirSync(workDir, { recursive: true });

  const snapped = Math.max(0, await keyframeAtOrBefore(clip.src, clip.start, o));
  const videoOut = path.join(workDir, `clip_${index}.mp4`);
  const audioOut = path.join(workDir, `clip_${index}.wav`);

  // +1 ms để làm tròn số thực không kéo ffmpeg lùi về keyframe trước đó nữa
  await run(o.ffmpeg, ['-y', '-hide_banner', '-ss', fmt(snapped + 0.001), '-t', fmt(clip.end - snapped),
    '-i', clip.src, '-map', '0:v:0', '-an', '-c:v', 'copy', '-avoid_negative_ts', 'make_zero', videoOut]);

  // Độ dài video THỰC TẾ là chuẩn; audio cắt theo nó, không theo END người dùng chọn
  const pj = await probeJson(o, ['-show_entries', 'format=duration', videoOut]);
  const dur = Number(pj.format?.duration);
  if (!(dur > 0)) throw new Error(`Clip ${index}: không đo được độ dài video`);

  const fade = Math.min(o.fadeMs / 1000, dur / 2);
  const af = `afade=t=in:d=${fmt(fade)},afade=t=out:st=${fmt(Math.max(0, dur - fade))}:d=${fmt(fade)}`;
  await run(o.ffmpeg, ['-y', '-hide_banner', '-ss', fmt(snapped), '-t', fmt(dur),
    '-i', cleanWav, '-af', af, '-c:a', 'pcm_f32le', audioOut]);

  return { video: videoOut, audio: audioOut, start: snapped, duration: dur };
}

/* ---------- Giai đoạn C ---------- */

export function writeConcatList(file, paths) {
  const body = paths.map(p => `file '${fwd(path.resolve(p)).replace(/'/g, "'\\''")}'`).join('\n');
  fs.writeFileSync(file, body + '\n');
}

export function lastJsonBlock(text) {
  const all = text.match(/\{[^{}]*\}/g); // khối JSON cuối cùng, bỏ qua dòng thống kê muxer theo sau
  if (!all) throw new Error('Không đọc được JSON của loudnorm:\n' + text.slice(-800));
  return JSON.parse(all[all.length - 1]);
}

export async function exportTimeline(clipResults, workDir, finalOut, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const warnings = [];

  const vList = path.join(workDir, 'concat_v.txt');
  const aList = path.join(workDir, 'concat_a.txt');
  const videoConcat = path.join(workDir, 'video_concat.mp4');
  const timeline = path.join(workDir, 'timeline.wav');

  writeConcatList(vList, clipResults.map(c => c.video));
  writeConcatList(aList, clipResults.map(c => c.audio));

  await run(o.ffmpeg, ['-y', '-hide_banner', '-f', 'concat', '-safe', '0', '-i', vList, '-c', 'copy', videoConcat]);
  await run(o.ffmpeg, ['-y', '-hide_banner', '-f', 'concat', '-safe', '0', '-i', aList, '-c', 'copy', timeline]);

  const ln = `I=${o.targetI}:TP=${o.targetTP}:LRA=${o.targetLRA}`;

  // Pass 1: đo
  const p1 = await run(o.ffmpeg, ['-hide_banner', '-i', timeline, '-af', `loudnorm=${ln}:print_format=json`, '-f', 'null', '-']);
  const m = lastJsonBlock(p1.stderr);
  if (m.input_i === '-inf' || m.input_i === '-Infinity') throw new Error('Timeline im lặng hoàn toàn, không thể chuẩn hóa');

  // Pass 2: áp dụng + AAC một lần
  const af = `loudnorm=${ln}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}` +
    `:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true:print_format=json,aresample=48000`;
  const p2 = await run(o.ffmpeg, ['-y', '-hide_banner', '-i', videoConcat, '-i', timeline,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-af', af,
    '-c:a', 'aac', '-b:a', o.aacBitrate, '-ar', '48000', '-movflags', '+faststart', finalOut]);

  let loud = null;
  try {
    loud = lastJsonBlock(p2.stderr);
    if (loud.normalization_type && loud.normalization_type !== 'linear')
      warnings.push(`loudnorm rơi về chế độ ${loud.normalization_type} (LRA đo được ${m.input_lra}, TP đo được ${m.input_tp}): ` +
        `LRA vượt mục tiêu ${o.targetLRA}, hoặc gain cần thiết đẩy đỉnh vượt TP ${o.targetTP} — có thể gây pumping`);
    if (Math.abs(Number(loud.output_i) - o.targetI) > 1.5)
      warnings.push(`Âm lượng đầu ra ${loud.output_i} LUFS lệch mục tiêu ${o.targetI}`);
  } catch (e) { warnings.push('Không đọc được thống kê loudnorm pass 2'); }

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
