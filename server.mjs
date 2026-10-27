import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, exec } from 'node:child_process';
import crypto from 'node:crypto';
import { getSignaturesBatch, planConcatWorkflow } from './video_concat_planner.mjs';

// Ngăn ngừa crash khi chạy ngầm không có cửa sổ console (EPIPE)
if (process.stdout && process.stdout.on) process.stdout.on('error', () => {});
if (process.stderr && process.stderr.on) process.stderr.on('error', () => {});

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'projects');
const PORT = Number(process.env.PORT || 4177);
const TTS_PORT = Number(process.env.TTS_PORT || 4178);
const mediaDurationCache = new Map();
async function getCachedDuration(fullP, mtimeMs) {
  const key = `${fullP}:${mtimeMs}`;
  if (mediaDurationCache.has(key)) return mediaDurationCache.get(key);
  const dur = await getMediaDuration(fullP);
  mediaDurationCache.set(key, dur);
  return dur;
}
const MIME = { '.html':'text/html; charset=utf-8', '.css':'text/css', '.js':'text/javascript', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.wav':'audio/wav', '.mp3':'audio/mpeg', '.mp4':'video/mp4', '.json':'application/json', '.wasm':'application/wasm', '.tflite':'application/octet-stream', '.data':'application/octet-stream' };
const WINGET_FFMPEG = 'C:\\Users\\OS\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.2-full_build\\bin\\ffmpeg.exe';
const FFMPEG_BIN = process.env.FFMPEG_PATH || (fsSync.existsSync(path.join(ROOT, 'runtime', 'ffmpeg.exe')) ? path.join(ROOT, 'runtime', 'ffmpeg.exe') : (fsSync.existsSync(WINGET_FFMPEG) ? WINGET_FFMPEG : 'ffmpeg'));

await fs.mkdir(DATA, { recursive: true });
const send = (res, status, value, type='application/json; charset=utf-8') => {
  if (!res || res.headersSent || res.writableEnded) return;
  try {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control':'no-store' });
    res.end(typeof value === 'string' ? value : JSON.stringify(value));
  } catch {}
};
const readJson = async req => { let s=''; for await (const chunk of req) { s += chunk; if (s.length > 80_000_000) throw new Error('Yêu cầu quá lớn.'); } return JSON.parse(s || '{}'); };
const safeId = id => /^[a-f0-9-]{8,64}$/i.test(id || '') ? id : null;
const projectDir = id => path.join(DATA, id);

// --- Real-time Progress Bus (Server-Sent Events) ---
const progressClients = new Map(); // taskId -> Set of res

function registerProgressClient(taskId, res) {
  if (!progressClients.has(taskId)) {
    progressClients.set(taskId, new Set());
  }
  progressClients.get(taskId).add(res);
}

function unregisterProgressClient(taskId, res) {
  if (progressClients.has(taskId)) {
    const clients = progressClients.get(taskId);
    clients.delete(res);
    if (clients.size === 0) progressClients.delete(taskId);
  }
}

function broadcastProgress(taskId, data) {
  if (!taskId || !progressClients.has(taskId)) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of progressClients.get(taskId)) {
    try {
      if (!client.writableEnded) client.write(payload);
    } catch {}
  }
}

async function resolveVideoFile(projectId, rawName) {
  const dir = projectDir(projectId);
  const clean = path.basename(String(rawName || '').replace(/^[\\\/]+/, ''));
  const candidate1 = path.join(dir, 'media', clean);
  const candidate2 = path.join(dir, clean);
  try {
    await fs.access(candidate1);
    return { fullPath: candidate1, fileName: clean, relPath: `media/${clean}` };
  } catch {}
  try {
    await fs.access(candidate2);
    return { fullPath: candidate2, fileName: clean, relPath: clean };
  } catch {}
  try {
    const entries = await fs.readdir(DATA, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isDirectory() && ent.name !== projectId) {
        const c3 = path.join(DATA, ent.name, 'media', clean);
        try {
          await fs.access(c3);
          return { fullPath: c3, fileName: clean, relPath: `media/${clean}`, foundInProject: ent.name };
        } catch {}
      }
    }
  } catch {}
  return null;
}

function killProcessTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') {
      exec(`taskkill /pid ${child.pid} /T /F`, () => {});
    } else {
      child.kill('SIGKILL');
    }
  } catch {}
}

const RECOMMENDED_THREADS = Math.min(4, Math.max(1, Math.floor((os.cpus() || []).length / 2)));

const run = (cmd, args, opts={}) => new Promise((resolve, reject) => {
  const { signal, timeout = 600000, inactivityTimeout = 0, onProgress, totalDuration, ...spawnOpts } = opts;
  const isFFmpeg = path.basename(cmd).toLowerCase().includes('ffmpeg');
  const finalArgs = [...args];
  if (isFFmpeg && !finalArgs.includes('-threads')) {
    finalArgs.unshift('-threads', String(RECOMMENDED_THREADS));
  }
  const child = spawn(cmd, finalArgs, { windowsHide:true, ...spawnOpts });
  if (child.pid && os.constants.priority?.PRIORITY_BELOW_NORMAL) {
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
  }
  let out='', err='';
  let aborted = false;
  let watchdogTimer = null;
  let maxTimer = null;
  let lastActiveTime = Date.now();
  let stderrBuffer = '';

  const cleanup = () => {
    if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
    if (maxTimer) { clearTimeout(maxTimer); maxTimer = null; }
    if (signal) { signal.removeEventListener('abort', onAbort); }
  };

  const onAbort = () => {
    aborted = true;
    cleanup();
    killProcessTree(child);
    reject(new Error('Thao tác đã bị người dùng dừng lại.'));
  };

  if (signal) {
    if (signal.aborted) {
      killProcessTree(child);
      return reject(new Error('Thao tác đã bị người dùng dừng lại.'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  // 1. Inactivity Watchdog: Kiểm tra mỗi 5s. Nếu bật inactivityTimeout (>0) và tiến trình không sinh output -> Treo -> kill
  if (inactivityTimeout > 0) {
    watchdogTimer = setInterval(() => {
      const idleTime = Date.now() - lastActiveTime;
      if (idleTime > inactivityTimeout) {
        aborted = true;
        cleanup();
        killProcessTree(child);
        console.warn(`[Process Inactivity Watchdog] Tác vụ ${path.basename(cmd)} bị treo không phản hồi sau ${Math.round(idleTime / 1000)}s. Đã tự động giải phóng tiến trình.`);
        reject(new Error(`Tác vụ ${path.basename(cmd)} bị treo không phản hồi sau ${Math.round(idleTime / 1000)}s. Đã tự động giải phóng tiến trình.`));
      }
    }, 5000);
  }

  // 2. Maximum Total Execution Timeout (Mặc định 10 phút, tránh rò rỉ vĩnh viễn)
  if (timeout > 0) {
    maxTimer = setTimeout(() => {
      aborted = true;
      cleanup();
      killProcessTree(child);
      console.warn(`[Process Timeout] Tác vụ ${path.basename(cmd)} vượt quá giới hạn tối đa ${Math.round(timeout / 1000)}s. Đã tự động giải phóng.`);
      reject(new Error(`Tác vụ ${path.basename(cmd)} vượt quá giới hạn tối đa ${Math.round(timeout / 1000)}s. Đã tự động giải phóng.`));
    }, timeout);
  }

  child.stdout?.on('data', d => {
    out += d;
    lastActiveTime = Date.now();
  });
  child.stderr?.on('data', d => {
    const chunk = d.toString();
    err += chunk;
    lastActiveTime = Date.now();

    // Phân tích Real-time Progress từ log FFmpeg (chuỗi time=00:00:15.23 speed= 31x)
    if (typeof onProgress === 'function') {
      stderrBuffer += chunk;
      // Trích xuất mốc time gần nhất
      const timeMatches = [...stderrBuffer.matchAll(/time=\s*(\d{2}):(\d{2}):([\d.]+)/g)];
      const speedMatches = [...stderrBuffer.matchAll(/speed=\s*([\d.]+x)/g)];
      if (timeMatches.length > 0) {
        const lastM = timeMatches[timeMatches.length - 1];
        const curSec = (parseInt(lastM[1], 10) * 3600) + (parseInt(lastM[2], 10) * 60) + parseFloat(lastM[3]);
        const speedStr = speedMatches.length > 0 ? speedMatches[speedMatches.length - 1][1] : '';
        try {
          onProgress({ curSec, speedStr, rawChunk: chunk });
        } catch {}
      }
      if (stderrBuffer.length > 2000) {
        stderrBuffer = stderrBuffer.slice(-1000);
      }
    }
  });
  child.on('error', (e) => {
    cleanup();
    if (!aborted) reject(e);
  });
  child.on('close', code => {
    cleanup();
    if (aborted || signal?.aborted) {
      return reject(new Error('Thao tác đã bị người dùng dừng lại.'));
    }
    code === 0 ? resolve({out,err}) : reject(new Error(err || `${cmd} exited ${code}`));
  });
});
const cleanName = s => String(s || '').replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/\.{2,}/g,'.').replace(/^\.+|\.+$/g,'').slice(0,80) || 'video';

let encoderMode = null;
async function detectBestEncoder() {
  if (encoderMode !== null) return encoderMode;
  // 1. Kiểm tra NVIDIA NVENC (NVENC cần khung hình tối thiểu 256x256)
  try {
    await run(FFMPEG_BIN, ['-hide_banner', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.1', '-c:v', 'h264_nvenc', '-f', 'null', '-'], { timeout: 3000, windowsHide: true });
    encoderMode = 'nvenc';
    console.log('[Hardware Acceleration] Phát hiện GPU NVIDIA: Sử dụng h264_nvenc siêu tốc!');
    return encoderMode;
  } catch {}

  // 2. Kiểm tra Intel QuickSync (h264_qsv cho laptop chip Intel Core/Ultra Onboard)
  try {
    await run(FFMPEG_BIN, ['-hide_banner', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.1', '-c:v', 'h264_qsv', '-f', 'null', '-'], { timeout: 3000, windowsHide: true });
    encoderMode = 'qsv';
    console.log('[Hardware Acceleration] Phát hiện GPU Intel QuickSync: Sử dụng h264_qsv tăng tốc phần cứng!');
    return encoderMode;
  } catch {}

  // 3. Kiểm tra AMD AMF (h264_amf cho laptop chip AMD Ryzen / Radeon)
  try {
    await run(FFMPEG_BIN, ['-hide_banner', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.1', '-c:v', 'h264_amf', '-f', 'null', '-'], { timeout: 3000, windowsHide: true });
    encoderMode = 'amf';
    console.log('[Hardware Acceleration] Phát hiện GPU AMD Radeon: Sử dụng h264_amf tăng tốc phần cứng!');
    return encoderMode;
  } catch {}

  // 4. Kiểm tra Windows Media Foundation (GPU onboard Intel HD/Iris Xe / AMD Radeon trên laptop thông thường)
  if (process.platform === 'win32') {
    try {
      await run(FFMPEG_BIN, ['-hide_banner', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.1', '-c:v', 'h264_mf', '-f', 'null', '-'], { timeout: 3000, windowsHide: true });
      encoderMode = 'mf';
      console.log('[Hardware Acceleration] Phát hiện GPU Laptop/PC (Media Foundation): Sử dụng h264_mf tăng tốc phần cứng mượt mà!');
      return encoderMode;
    } catch {}
  }

  // 5. Dự phòng CPU libx264 ultrafast (chạy được trên 100% mọi dòng máy tính)
  encoderMode = 'cpu';
  console.log('[Hardware Acceleration] Chạy chế độ CPU libx264 ultrafast tương thích 100% mọi máy tính!');
  return encoderMode;
}


async function getQualityEncoderArgs(targetRes = '1080p', isHighQuality = true) {
  const mode = await detectBestEncoder();
  let bRate = '8M';
  let maxRate = '12M';
  let cq = '20';
  let crf = '20';

  if (targetRes === '4k' || targetRes === '2160p') {
    bRate = '25M'; maxRate = '32M'; cq = '18'; crf = '18';
  } else if (targetRes === '2k' || targetRes === '1440p') {
    bRate = '14M'; maxRate = '18M'; cq = '19'; crf = '19';
  } else if (targetRes === '720p') {
    bRate = '4M'; maxRate = '6M'; cq = '23'; crf = '22';
  }

  if (mode === 'nvenc') {
    return ['-c:v', 'h264_nvenc', '-preset', 'p2', '-tune', 'll', '-cq', cq, '-b:v', bRate, '-maxrate', maxRate, '-pix_fmt', 'yuv420p'];
  }
  if (mode === 'qsv') {
    return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', cq, '-pix_fmt', 'yuv420p'];
  }
  if (mode === 'amf') {
    return ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', cq, '-qp_p', cq, '-pix_fmt', 'yuv420p'];
  }
  // Siêu tối ưu cho Laptop văn phòng không GPU: đa luồng cực nhanh, máy mát êm ru
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', crf, '-threads', '0', '-pix_fmt', 'yuv420p'];
}

async function getFastEncoderArgs() {
  const mode = await detectBestEncoder();
  if (mode === 'nvenc') {
    return ['-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'ull', '-cq', '23', '-pix_fmt', 'yuv420p'];
  }
  if (mode === 'qsv') {
    return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '23', '-pix_fmt', 'nv12'];
  }
  if (mode === 'amf') {
    return ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '23', '-qp_p', '23', '-pix_fmt', 'yuv420p'];
  }
  if (mode === 'mf') {
    return ['-c:v', 'h264_mf', '-b:v', '3000k', '-pix_fmt', 'yuv420p'];
  }
  return ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22', '-pix_fmt', 'yuv420p'];
}

async function voices() {
  if (process.platform !== 'win32') return [];
  try { const {out}=await run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(ROOT,'scripts','voices.ps1')]); return JSON.parse(out.trim()); } catch { return []; }
}
async function ttsStatus() {
  let service=null;
  try { const r=await fetch(`http://127.0.0.1:${TTS_PORT}/health`,{signal:AbortSignal.timeout(8000)}); if(r.ok) service=await r.json(); } catch {}
  return {service,windowsVoices:await voices()};
}
async function synthesize(id, sceneId, text, voiceName) {
  const dir=projectDir(id), wav=`voice-${sceneId}.wav`, input=path.join(dir,`tts-${sceneId}.json`);
  await fs.writeFile(input, JSON.stringify({ text, voiceName: voiceName || '' }), 'utf8');
  await run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(ROOT,'scripts','speak.ps1'),'-InputJson',input,'-OutputWav',path.join(dir,wav)],{cwd:dir});
  return wav;
}

const AUDIO_VERSION = 'a1.0.0';
const RENDER_VERSION = 'r1.0.0';
const WINGET_FFPROBE = 'C:\\Users\\OS\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.2-full_build\\bin\\ffprobe.exe';
const FFPROBE_BIN = process.env.FFPROBE_PATH || (fsSync.existsSync(path.join(ROOT, 'runtime', 'ffprobe.exe')) ? path.join(ROOT, 'runtime', 'ffprobe.exe') : (fsSync.existsSync(WINGET_FFPROBE) ? WINGET_FFPROBE : 'ffprobe'));

function getSystemFont() {
  const isWin = process.platform === 'win32';
  if (!isWin) {
    return { path: 'Arial', size: 0, mtime: 0, drawtext: "font='Arial'" };
  }
  const candidates = [
    'C:\\Windows\\Fonts\\arial.ttf',
    'C:\\Windows\\Fonts\\segoeui.ttf',
    'C:\\Windows\\Fonts\\tahoma.ttf'
  ];
  for (const p of candidates) {
    try {
      const stat = fsSync.statSync(p);
      const escaped = p.replace(/\\/g, '/').replace(/:/g, '\\:');
      return { path: p, size: stat.size, mtime: stat.mtimeMs, drawtext: `fontfile='${escaped}'` };
    } catch {}
  }
  return { path: 'Arial', size: 0, mtime: 0, drawtext: "font='Arial'" };
}

async function fileSha256(filePath) {
  try {
    const buf = await fs.readFile(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch {
    return '';
  }
}

function computeAudioHash(scene, extraSettings = {}) {
  const normalizedText = String(scene.text || '').trim().replace(/\s+/g, ' ');
  const engine = String(scene.voiceEngine || 'auto');
  const voice = String(scene.voiceName || '');
  const speed = String(scene.speed || 1.0);
  const extraStr = JSON.stringify(extraSettings || {});
  return crypto.createHash('sha256')
    .update(`${normalizedText}|${engine}|${voice}|${speed}|${extraStr}|${AUDIO_VERSION}`)
    .digest('hex');
}

async function computeVisualHash(project, scene, realAudioDuration) {
  const dir = projectDir(project.id);
  const fontMeta = getSystemFont();
  const fontStr = `${fontMeta.path}|${fontMeta.size}|${fontMeta.mtime}`;

  let imgHash = '';
  if (scene.imageName) {
    imgHash = await fileSha256(path.join(dir, 'media', scene.imageName));
  }
  let videoHash = '';
  if (scene.generated_video) {
    videoHash = await fileSha256(path.join(dir, scene.generated_video));
  }

  const templateOrStyle = scene.template || scene.style || (scene.type === 'slide' ? 'title' : 'default');
  const effect = scene.animationEffect || 'static';
  const cropMode = scene.cropMode || 'contain';
  const ratio = project.ratio || '16:9';
  const res = project.resolution || '720p';
  const duration = Number(realAudioDuration || scene.duration || 6).toFixed(3);
  const fontSize = String(scene.fontSize || '');
  const subtitleOpts = JSON.stringify(scene.subtitleOpts || {});
  const quizDelaySec = String(scene.quizDelaySec || '');

  return crypto.createHash('sha256')
    .update(`${templateOrStyle}|${imgHash}|${videoHash}|${effect}|${cropMode}|${ratio}|${res}|${duration}|${fontSize}|${subtitleOpts}|${quizDelaySec}|${fontStr}|${RENDER_VERSION}`)
    .digest('hex');
}

function computeSceneHash(audioHash, visualHash) {
  return crypto.createHash('sha256')
    .update(`${audioHash}|${visualHash}|${RENDER_VERSION}`)
    .digest('hex');
}

async function getMediaDuration(filePath) {
  try {
    const { err } = await run(FFMPEG_BIN, ['-hide_banner', '-i', filePath], { windowsHide: true });
    const m = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  } catch (e) {
    const errText = e.message || '';
    const m = errText.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
  return null;
}

async function hasAudioStream(filePath) {
  try {
    const { err } = await run(FFMPEG_BIN, ['-hide_banner', '-i', filePath], { windowsHide: true });
    return /Stream #\d+:\d+.*Audio:/i.test(err);
  } catch (e) {
    return /Stream #\d+:\d+.*Audio:/i.test(e.message || '');
  }
}

async function getVideoStreamInfo(filePath) {
  try {
    const { out } = await run(FFPROBE_BIN, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,sample_aspect_ratio,display_aspect_ratio,codec_name,r_frame_rate,duration',
      '-of', 'json',
      filePath
    ], { timeout: 8000, windowsHide: true });
    const data = JSON.parse(out || '{}');
    const stream = (data.streams && data.streams[0]) || {};
    return {
      width: Number(stream.width) || 1280,
      height: Number(stream.height) || 720,
      sar: stream.sample_aspect_ratio || '1:1',
      dar: stream.display_aspect_ratio || '16:9',
      codec: stream.codec_name || 'h264',
      fps: stream.r_frame_rate || '30/1',
      duration: Number(stream.duration) || 0
    };
  } catch (err) {
    return { width: 1280, height: 720, sar: '1:1', dar: '16:9', codec: 'h264', fps: '30/1', duration: 0 };
  }
}

async function getStreamDurations(filePath) {
  try {
    const { out } = await run(FFPROBE_BIN, [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,duration',
      '-of', 'json',
      filePath
    ], { windowsHide: true });
    const info = JSON.parse(out || '{}');
    const streams = info.streams || [];
    let videoDur = null, audioDur = null;
    for (const s of streams) {
      if (s.codec_type === 'video' && s.duration) videoDur = Number(s.duration);
      if (s.codec_type === 'audio' && s.duration) audioDur = Number(s.duration);
    }
    return { videoDur, audioDur };
  } catch {
    return { videoDur: null, audioDur: null };
  }
}

async function cleanProjectCache(projectId, activeSceneHashes = []) {
  const dir = projectDir(projectId);
  const cacheDir = path.join(dir, 'cache');
  try {
    const entries = await fs.readdir(cacheDir, { withFileTypes: true });
    let deletedCount = 0;
    for (const e of entries) {
      if (!e.isFile()) continue;
      const fullPath = path.join(cacheDir, e.name);
      if (e.name.startsWith('tmp_')) {
        await fs.unlink(fullPath).catch(() => {});
        deletedCount++;
      } else if (e.name.startsWith('scene_') && e.name.endsWith('.mp4')) {
        const isReferenced = activeSceneHashes.some(h => e.name.includes(h.slice(0, 16)));
        if (!isReferenced && activeSceneHashes.length > 0) {
          await fs.unlink(fullPath).catch(() => {});
          deletedCount++;
        }
      }
    }
    return { ok: true, deletedCount };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function renderIntermediateScene(project, scene, index) {
  const dir = projectDir(project.id);
  const cacheDir = path.join(dir, 'cache');
  await fs.mkdir(cacheDir, { recursive: true });

  const hasVideo = Boolean(scene.generated_video && /^[\w./\\-]+$/.test(scene.generated_video));
  const hasImage = Boolean(scene.imageName && /^[\w.-]+$/.test(scene.imageName));
  const voice = scene.voiceFile;
  const hasVoice = Boolean(voice && /^[\w.-]+$/.test(voice));

  let audioDur = 0;
  if (hasVoice) {
    const voicePath = path.join(dir, voice);
    try {
      await fs.access(voicePath);
      audioDur = (await getMediaDuration(voicePath)) || 0;
    } catch {
      audioDur = 0;
    }
  }

  let videoDur = 0;
  if (hasVideo) {
    const vidPath = path.join(dir, scene.generated_video);
    try {
      await fs.access(vidPath);
      videoDur = (await getMediaDuration(vidPath)) || 0;
    } catch {
      videoDur = 0;
    }
  }

  const manualSec = Math.max(2, Math.min(60, Number(scene.duration) || 6));
  // Round to exact frame boundary at 30 fps
  const rawTarget = Math.max(manualSec, audioDur > 0 ? audioDur + 0.1 : 0, videoDur > 0 ? videoDur : 0);
  const targetDuration = Math.ceil(rawTarget * 30) / 30;
  const targetDurStr = targetDuration.toFixed(3);

  // Compute Dual Hashes
  const audioHash = computeAudioHash(scene);
  const visualHash = await computeVisualHash(project, scene, audioDur);
  const sceneHash = computeSceneHash(audioHash, visualHash);

  const cacheFileName = `scene_${scene.id}_${sceneHash.slice(0, 16)}.mp4`;
  const cacheFilePath = path.join(cacheDir, cacheFileName);

  // Check Cache Hit
  try {
    const stat = await fs.stat(cacheFilePath);
    if (stat.size > 2000) {
      console.log(`[Cache Hit] Cảnh ${index + 1} (${scene.id}): ${cacheFileName} (${stat.size} bytes)`);
      return {
        sceneId: scene.id,
        file: path.join('cache', cacheFileName),
        fullPath: cacheFilePath,
        duration: targetDuration,
        cacheHit: true,
        audioHash,
        visualHash,
        sceneHash
      };
    }
  } catch {}

  console.log(`[Cache Miss] Cảnh ${index + 1} (${scene.id}): Đang render MP4 trung gian (dur=${targetDurStr}s)...`);

  const is1080p = project.resolution === '1080p';
  const scale = is1080p ? 1.5 : 1.0;
  const isVertical = project.ratio === '9:16';
  const width = isVertical ? (is1080p ? 1080 : 720) : (is1080p ? 1920 : 1280);
  const height = isVertical ? (is1080p ? 1920 : 1280) : (is1080p ? 1080 : 720);
  const maxChars = isVertical ? 24 : 40;
  const fontsize = Math.round(34 * scale);
  const boxborderw = Math.round(15 * scale);
  const yOffset = Math.round(48 * scale);
  const lineSpacing = Math.round(8 * scale);

  const captionRegex = new RegExp(`.{1,${maxChars}}(?:\\s|$)|\\S.{0,${maxChars - 1}}`, 'gu');
  const caption = (String(scene.text || '').trim().match(captionRegex) || []).join('\n');
  const captionPath = path.join(dir, `caption-${index}.txt`);
  await fs.writeFile(captionPath, caption, 'utf8');

  const fontMeta = getSystemFont();
  const drawtextFilter = `drawtext=${fontMeta.drawtext}:textfile='caption-${index}.txt':fontcolor=white:fontsize=${fontsize}:line_spacing=${lineSpacing}:x=(w-text_w)/2:y=h-text_h-${yOffset}:box=1:boxcolor=black@0.58:boxborderw=${boxborderw}:fix_bounds=1`;

  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  let vFilter = '';
  let aFilter = '';

  if (hasVideo) {
    args.push('-stream_loop', '-1', '-i', path.join(dir, scene.generated_video));
    vFilter = `[0:v]fps=30,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x101827,setsar=1,trim=0:${targetDurStr},setpts=PTS-STARTPTS,${drawtextFilter},format=yuv420p[v]`;
  } else if (hasImage) {
    const imgPath = path.join(dir, 'media', scene.imageName);
    args.push('-loop', '1', '-framerate', '30', '-t', targetDurStr, '-i', imgPath);
    vFilter = `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x101827,setsar=1,fps=30,trim=0:${targetDurStr},setpts=PTS-STARTPTS,${drawtextFilter},format=yuv420p[v]`;
  } else {
    // Blank visual slide with pedagogical slate background
    args.push('-f', 'lavfi', '-i', `color=c=0x1e293b:s=${width}x${height}:d=${targetDurStr}`);
    vFilter = `[0:v]fps=30,setsar=1,trim=0:${targetDurStr},setpts=PTS-STARTPTS,${drawtextFilter},format=yuv420p[v]`;
  }

  if (hasVoice) {
    args.push('-i', path.join(dir, voice));
    aFilter = `[1:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,apad,atrim=0:${targetDurStr},asetpts=PTS-STARTPTS[a]`;
  } else {
    // Explicit silence stream with identical parameters (AAC, 44100Hz stereo)
    aFilter = `anullsrc=r=44100:cl=stereo,atrim=0:${targetDurStr},asetpts=PTS-STARTPTS[a]`;
  }

  const crf = is1080p ? '20' : '22';
  const audioBitrate = is1080p ? '192k' : '160k';

  // Atomic write to temporary file
  const tmpFileName = `tmp_${crypto.randomUUID()}.mp4`;
  const tmpFilePath = path.join(cacheDir, tmpFileName);

  args.push(
    '-filter_complex', `${vFilter};${aFilter}`,
    '-map', '[v]',
    '-map', '[a]',
    '-c:v', 'libx264',
    '-profile:v', 'high',
    '-preset', 'veryfast',
    '-crf', crf,
    '-r', '30',
    '-video_track_timescale', '30000',
    '-pix_fmt', 'yuv420p',
    '-t', targetDurStr,
    '-c:a', 'aac',
    '-ar', '44100',
    '-ac', '2',
    '-b:a', audioBitrate,
    '-movflags', '+faststart',
    tmpFilePath
  );

  await run(FFMPEG_BIN, args, { cwd: dir });

  // Verify and rename atomically
  const tmpStat = await fs.stat(tmpFilePath);
  if (tmpStat.size < 1000) {
    await fs.unlink(tmpFilePath).catch(() => {});
    throw new Error(`Render cảnh ${index + 1} thất bại (file đầu ra rỗng).`);
  }

  await fs.rename(tmpFilePath, cacheFilePath);
  console.log(`[Cache Saved] Cảnh ${index + 1} -> ${cacheFileName} (${tmpStat.size} bytes)`);

  return {
    sceneId: scene.id,
    file: path.join('cache', cacheFileName),
    fullPath: cacheFilePath,
    duration: targetDuration,
    cacheHit: false,
    audioHash,
    visualHash,
    sceneHash
  };
}

async function render(project) {
  const id = safeId(project.id);
  if (!id) throw new Error('Mã dự án không hợp lệ.');
  const dir = projectDir(id);
  const scenes = project.scenes || [];
  if (!scenes.length) throw new Error('Hãy thêm ít nhất một cảnh.');

  if (project.script_approved === false) {
    throw new Error('Kịch bản đã bị sửa đổi nội dung. Vui lòng bấm Duyệt kịch bản trước khi tạo video.');
  }

  const renderStart = Date.now();
  console.log(`\n[Master Render] Bắt đầu render dự án: "${project.title}" (${scenes.length} cảnh)`);

  // Bước 1: Render từng cảnh trung gian (hoặc đọc từ cache)
  const renderedScenes = [];
  let totalDuration = 0;
  let cacheHits = 0;

  for (let i = 0; i < scenes.length; i++) {
    const res = await renderIntermediateScene(project, scenes[i], i);
    renderedScenes.push(res);
    totalDuration += res.duration;
    if (res.cacheHit) cacheHits++;
  }

  console.log(`[Master Render] Đã chuẩn bị ${renderedScenes.length} cảnh (Cache Hit: ${cacheHits}/${renderedScenes.length})`);

  // Bước 2: Tạo concat_list.txt với escaping an toàn
  const concatListPath = path.join(dir, 'concat_list.txt');
  const lines = renderedScenes.map(s => {
    const escapedFile = s.file.replace(/\\/g, '/').replace(/'/g, "'\\''");
    return `file '${escapedFile}'`;
  });
  await fs.writeFile(concatListPath, lines.join('\n'), 'utf8');

  // Bước 3: Ghép nối Stream Copy (-c copy)
  const output = `${cleanName(project.title)}.mp4`;
  const copyStart = Date.now();
  const copyArgs = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0',
    '-i', 'concat_list.txt',
    '-c', 'copy',
    '-movflags', '+faststart',
    output
  ];

  let concatMethod = 'stream_copy';
  try {
    await run(FFMPEG_BIN, copyArgs, { cwd: dir });
  } catch (copyErr) {
    console.warn(`[Master Render] Stream copy concat thất bại (${copyErr.message}), kích hoạt fallback re-encode...`);
    concatMethod = 're_encode_fallback';
    const is1080p = project.resolution === '1080p';
    const crf = is1080p ? '20' : '22';
    const audioBitrate = is1080p ? '192k' : '160k';
    const fallbackArgs = [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0',
      '-i', 'concat_list.txt',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', crf,
      '-c:a', 'aac',
      '-b:a', audioBitrate,
      '-movflags', '+faststart',
      output
    ];
    await run(FFMPEG_BIN, fallbackArgs, { cwd: dir });
  }

  const finalDuration = (await getMediaDuration(path.join(dir, output))) || Math.round(totalDuration);
  const totalMs = Date.now() - renderStart;
  const concatMs = Date.now() - copyStart;

  console.log(`[Master Render Hoàn Tất] Output: ${output} | Thời lượng: ${finalDuration}s | Phương thức: ${concatMethod} | Thời gian ghép: ${concatMs}ms | Tổng: ${totalMs}ms\n`);

  return {
    output,
    duration: Math.round(finalDuration),
    totalMs,
    concatMs,
    concatMethod,
    cacheHits,
    totalScenes: scenes.length
  };
}

let lastHeartbeatTime = Date.now();
let heartbeatActive = false;
setInterval(() => {
  if (heartbeatActive && (Date.now() - lastHeartbeatTime > 60000)) {
    console.log('[App Auto-Close] Không có kết nối trong 60s. Thoát ứng dụng...');
    process.exit(0);
  }
}, 15000);

const server=http.createServer(async (req,res)=>{
  try {
    const url=new URL(req.url,'http://127.0.0.1');
    if(url.pathname==='/api/heartbeat') {
      lastHeartbeatTime = Date.now();
      heartbeatActive = true;
      return send(res, 200, { ok: true });
    }
    if(req.method==='GET' && url.pathname==='/api/update/check') {
      try {
        let localVersion = { version: '1.0.0', notes: '' };
        try {
          const raw = await fs.readFile(path.join(ROOT, 'version.json'), 'utf8');
          localVersion = JSON.parse(raw);
        } catch {}
        const remoteUrl = 'https://raw.githubusercontent.com/tiendung04dtvt-debug/fast-edit/main/version.json?_t=' + Date.now();
        const r = await fetch(remoteUrl, { signal: AbortSignal.timeout(6000) });
        if (!r.ok) {
          if (r.status === 404) {
            return send(res, 200, {
              ok: true,
              hasUpdate: false,
              localVersion: localVersion.version,
              remoteVersion: localVersion.version,
              notes: 'Bạn đang dùng phiên bản mới nhất.',
              files: []
            });
          }
          return send(res, 200, { ok: false, error: 'Không thể lấy thông tin cập nhật từ GitHub (HTTP ' + r.status + ')' });
        }
        const remoteVersion = await r.json();
        const hasUpdate = String(remoteVersion.version || '').trim() !== String(localVersion.version || '').trim();
        return send(res, 200, {
          ok: true,
          hasUpdate,
          localVersion: localVersion.version,
          remoteVersion: remoteVersion.version,
          notes: remoteVersion.notes || '',
          updatedAt: remoteVersion.updatedAt || '',
          files: remoteVersion.files || []
        });
      } catch (err) {
        return send(res, 200, { ok: false, error: 'Không thể kết nối GitHub (chưa có mạng hoặc bị chặn): ' + err.message });
      }
    }
    if(req.method==='POST' && url.pathname==='/api/update/apply') {
      try {
        const remoteUrl = 'https://raw.githubusercontent.com/tiendung04dtvt-debug/fast-edit/main/version.json?_t=' + Date.now();
        const r = await fetch(remoteUrl, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) return send(res, 502, { ok: false, error: 'Không thể kết nối GitHub để tải cấu hình cập nhật' });
        const remoteVersion = await r.json();
        const filesToDownload = Array.isArray(remoteVersion.files) && remoteVersion.files.length > 0
          ? remoteVersion.files
          : ['public/index.html', 'server.mjs', 'video_concat_planner.mjs', 'version.json', 'package.json'];
        
        const downloaded = [];
        for (const relFile of filesToDownload) {
          const cleanRel = relFile.replace(/^[\\\/]+/, '').replace(/\\/g, '/');
          if (cleanRel.includes('..') || path.isAbsolute(cleanRel)) continue;
          const fileUrl = `https://raw.githubusercontent.com/tiendung04dtvt-debug/fast-edit/main/${cleanRel}?_t=` + Date.now();
          const fr = await fetch(fileUrl, { signal: AbortSignal.timeout(15000) });
          if (!fr.ok) throw new Error(`Không tải được file ${cleanRel} (HTTP ${fr.status})`);
          const text = await fr.text();
          const targetPath = path.join(ROOT, cleanRel);
          await fs.mkdir(path.dirname(targetPath), { recursive: true });
          await fs.writeFile(targetPath, text, 'utf8');
          downloaded.push(cleanRel);
        }
        
        await fs.writeFile(path.join(ROOT, 'version.json'), JSON.stringify(remoteVersion, null, 2), 'utf8');
        return send(res, 200, {
          ok: true,
          message: `Đã cập nhật thành công lên bản v${remoteVersion.version}!`,
          newVersion: remoteVersion.version,
          files: downloaded
        });
      } catch (err) {
        return send(res, 500, { ok: false, error: 'Lỗi khi cập nhật: ' + err.message });
      }
    }
    if(req.method==='GET' && url.pathname==='/api/voices') return send(res,200,{voices:await voices(),platform:process.platform});
    if(req.method==='GET' && url.pathname==='/api/tts/status') return send(res,200,{...(await ttsStatus()),platform:process.platform});
    if(req.method==='POST' && url.pathname==='/api/script/split') {
      const body = await readJson(req);
      try {
        const r = await fetch(`http://127.0.0.1:${TTS_PORT}/script/split`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10000)
        });
        const data = await r.json();
        return send(res, r.status, data);
      } catch(e) {
        return send(res, 502, { error: 'Không thể kết nối tới bộ tách kịch bản: ' + e.message });
      }
    }
    if(req.method==='POST' && url.pathname==='/api/projects') {
      const body=await readJson(req), id=crypto.randomUUID(), dir=projectDir(id); await fs.mkdir(path.join(dir,'media'),{recursive:true});
      const project={id,title:cleanName(body.title)||'Bài giảng mới',ratio:body.ratio==='9:16'?'9:16':'16:9',resolution:body.resolution==='1080p'?'1080p':'720p',scenes:[],updatedAt:new Date().toISOString()};
      await fs.writeFile(path.join(dir,'project.json'),JSON.stringify(project,null,2)); return send(res,201,project);
    }
    if(req.method==='GET' && url.pathname==='/api/projects') {
      const entries=await fs.readdir(DATA,{withFileTypes:true}), projects=[];
      for(const e of entries) if(e.isDirectory()) try { projects.push(JSON.parse(await fs.readFile(path.join(DATA,e.name,'project.json'),'utf8'))); } catch {}
      projects.sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||'')); return send(res,200,{projects});
    }
    if(req.method==='GET' && url.pathname.startsWith('/api/projects/')) {
      const id=safeId(url.pathname.split('/')[3]); if(!id) return send(res,400,{error:'Mã dự án không hợp lệ.'});
      const p=JSON.parse(await fs.readFile(path.join(projectDir(id),'project.json'),'utf8')); return send(res,200,p);
    }
    if(req.method==='POST' && url.pathname==='/api/save') {
      const project=await readJson(req), id=safeId(project.id); if(!id) return send(res,400,{error:'Mã dự án không hợp lệ.'});
      const pPath = path.join(projectDir(id), 'project.json');
      let oldProject = {};
      try { oldProject = JSON.parse(await fs.readFile(pPath, 'utf8')); } catch {}

      let textChanged = false;
      const oldScenes = oldProject.scenes || [];
      const newScenes = project.scenes || [];
      if (oldScenes.length !== newScenes.length) {
        textChanged = true;
      } else {
        for (let i = 0; i < oldScenes.length; i++) {
          if (String(oldScenes[i].text || '').trim() !== String(newScenes[i].text || '').trim()) {
            textChanged = true;
            break;
          }
        }
      }
      if (textChanged && !project.explicit_approve) {
        project.script_approved = false;
        console.log(`[Script Validation] Dự án ${id}: Nội dung kịch bản bị sửa đổi -> Tự động hủy script_approved = false.`);
      } else if (project.script_approved === undefined) {
        project.script_approved = oldProject.script_approved ?? true;
      }
      project.title=cleanName(project.title); project.updatedAt=new Date().toISOString();
      await fs.writeFile(pPath,JSON.stringify(project,null,2)); return send(res,200,{ok:true,project});
    }
    if(req.method==='POST' && url.pathname.includes('/approve-script')) {
      const id = safeId(url.pathname.split('/')[3]);
      if(!id) return send(res,400,{error:'Mã dự án không hợp lệ.'});
      const pPath = path.join(projectDir(id), 'project.json');
      const p = JSON.parse(await fs.readFile(pPath, 'utf8'));
      p.script_approved = true;
      p.updatedAt = new Date().toISOString();
      await fs.writeFile(pPath, JSON.stringify(p, null, 2), 'utf8');
      console.log(`[Script Validation] Dự án ${id}: Đã DUYỆT kịch bản thành công.`);
      return send(res, 200, { ok: true, script_approved: true, project: p });
    }
    if(req.method==='POST' && url.pathname.includes('/cache/clean')) {
      const id = safeId(url.pathname.split('/')[3]);
      if(!id) return send(res,400,{error:'Mã dự án không hợp lệ.'});
      const pPath = path.join(projectDir(id), 'project.json');
      let p = { scenes: [] };
      try { p = JSON.parse(await fs.readFile(pPath, 'utf8')); } catch {}
      const activeHashes = [];
      for (const s of (p.scenes || [])) {
        const aHash = computeAudioHash(s);
        const vHash = await computeVisualHash(p, s, 0);
        activeHashes.push(computeSceneHash(aHash, vHash));
      }
      const resClean = await cleanProjectCache(id, activeHashes);
      return send(res, 200, resClean);
    }
    if(req.method==='POST' && url.pathname.match(/\/api\/projects\/([^\/]+)\/scenes\/([^\/]+)\/render/)) {
      const m = url.pathname.match(/\/api\/projects\/([^\/]+)\/scenes\/([^\/]+)\/render/);
      const id = safeId(m[1]), sceneId = m[2];
      if(!id) return send(res,400,{error:'Mã dự án không hợp lệ.'});
      const pPath = path.join(projectDir(id), 'project.json');
      const p = JSON.parse(await fs.readFile(pPath, 'utf8'));
      const sceneIdx = (p.scenes || []).findIndex(sc => String(sc.id) === String(sceneId));
      if (sceneIdx === -1) return send(res, 404, { error: 'Không tìm thấy cảnh này.' });
      const targetScene = p.scenes[sceneIdx];
      const resRender = await renderIntermediateScene(p, targetScene, sceneIdx);
      return send(res, 200, resRender);
    }
    if(req.method==='POST' && (url.pathname==='/api/upload-video-stream' || url.pathname==='/api/video/upload-stream' || url.pathname.includes('/upload-custom'))) {
      const matchCustom = url.pathname.match(/\/api\/projects\/([^\/]+)\/upload-custom/);
      const projectId = safeId(url.searchParams.get('id') || url.searchParams.get('projectId') || (matchCustom && matchCustom[1]));
      if(!projectId) return send(res,400,{error:'Mã dự án không hợp lệ.'});
      const rawExt = (url.searchParams.get('ext') || path.extname(url.searchParams.get('name') || '') || '.mp4').toLowerCase();
      const ext = ['.mp4','.mov','.mkv','.webm','.avi'].includes(rawExt) ? rawExt : '.mp4';
      const dir = projectDir(projectId);
      const mediaDir = path.join(dir, 'media');
      await fs.mkdir(mediaDir, { recursive: true });
      const name = `${crypto.randomUUID()}${ext}`;
      const destPath = path.join(mediaDir, name);

      const writeStream = fsSync.createWriteStream(destPath);
      let totalBytes = 0;
      const MAX_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB

      req.on('data', chunk => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_SIZE) {
          req.destroy(new Error('Tệp vượt quá giới hạn 2 GB.'));
        }
      });

      req.pipe(writeStream);

      writeStream.on('finish', async () => {
        try {
          const dur = await getMediaDuration(destPath);
          console.log(`[Upload Video Stream] Tải thành công video: ${name} (${(totalBytes / (1024*1024)).toFixed(1)} MB, dur=${dur ? dur.toFixed(1) : '?'}s)`);
          return send(res, 201, {
            name: name,
            relPath: `media/${name}`,
            sizeBytes: totalBytes,
            duration: dur
          });
        } catch(e) {
          return send(res, 201, { name: name, relPath: `media/${name}`, sizeBytes: totalBytes });
        }
      });

      writeStream.on('error', err => {
        fs.unlink(destPath).catch(() => {});
        return send(res, 500, { error: 'Lỗi ghi tệp video: ' + err.message });
      });
      return;
    }
    if(req.method==='GET' && url.pathname==='/api/video/list') {
      const projectId = safeId(url.searchParams.get('id') || url.searchParams.get('projectId'));
      const candidateFiles = [];
      const seenNames = new Set();
      try {
        if (projectId) {
          const mediaDir = path.join(projectDir(projectId), 'media');
          if (fsSync.existsSync(mediaDir)) {
            const files = await fs.readdir(mediaDir);
            for (const f of files) {
              const ext = path.extname(f).toLowerCase();
              if (['.mp4', '.mov', '.mkv', '.webm', '.avi'].includes(ext) && !seenNames.has(f)) {
                seenNames.add(f);
                candidateFiles.push({ f, pId: projectId, fullP: path.join(mediaDir, f) });
              }
            }
          }
        }
        const entries = await fs.readdir(DATA, { withFileTypes: true }).catch(() => []);
        for (const ent of entries) {
          if (ent.isDirectory() && ent.name !== projectId) {
            const pMedia = path.join(DATA, ent.name, 'media');
            if (fsSync.existsSync(pMedia)) {
              const pFiles = await fs.readdir(pMedia).catch(() => []);
              for (const pf of pFiles) {
                const ext = path.extname(pf).toLowerCase();
                if (['.mp4', '.mov', '.mkv', '.webm', '.avi'].includes(ext) && !seenNames.has(pf)) {
                  seenNames.add(pf);
                  candidateFiles.push({ f: pf, pId: ent.name, fullP: path.join(pMedia, pf) });
                }
              }
            }
          }
        }
        const resolved = (await Promise.all(candidateFiles.map(async item => {
          const stat = await fs.stat(item.fullP).catch(() => null);
          if (!stat) return null;
          const dur = await getCachedDuration(item.fullP, stat.mtimeMs);
          return {
            name: item.f,
            projectId: item.pId,
            url: `/projects/${item.pId}/media/${item.f}`,
            sizeMb: (stat.size / (1024 * 1024)).toFixed(1),
            duration: dur || 0,
            mtime: stat.mtimeMs
          };
        }))).filter(Boolean);
        resolved.sort((a, b) => b.mtime - a.mtime);
        return send(res, 200, { ok: true, videos: resolved.slice(0, 50) });
      } catch (err) {
        return send(res, 500, { error: err.message });
      }
    }
    if(req.method==='POST' && url.pathname==='/api/video/clear-all') {
      try {
        const entries = await fs.readdir(DATA, { withFileTypes: true }).catch(() => []);
        let deletedCount = 0;
        for (const ent of entries) {
          if (ent.isDirectory()) {
            const pMedia = path.join(DATA, ent.name, 'media');
            if (fsSync.existsSync(pMedia)) {
              const pFiles = await fs.readdir(pMedia).catch(() => []);
              for (const pf of pFiles) {
                const ext = path.extname(pf).toLowerCase();
                if (['.mp4', '.mov', '.mkv', '.webm', '.avi'].includes(ext)) {
                  await fs.unlink(path.join(pMedia, pf)).catch(() => {});
                  deletedCount++;
                }
              }
            }
          }
        }
        mediaDurationCache.clear();
        return send(res, 200, { ok: true, deletedCount });
      } catch (err) {
        return send(res, 500, { error: err.message });
      }
    }
    if(req.method==='POST' && url.pathname==='/api/open-folder') {
      const body = await readJson(req);
      const projectId = safeId(body.projectId || body.id);
      const videoName = path.basename(String(body.videoName || body.name || ''));
      let targetFile = null;
      if (projectId && videoName) {
        const p1 = path.join(projectDir(projectId), 'media', videoName);
        if (fsSync.existsSync(p1)) targetFile = p1;
      }
      if (!targetFile && videoName) {
        const entries = await fs.readdir(DATA, { withFileTypes: true }).catch(() => []);
        for (const ent of entries) {
          if (ent.isDirectory()) {
            const p2 = path.join(DATA, ent.name, 'media', videoName);
            if (fsSync.existsSync(p2)) { targetFile = p2; break; }
          }
        }
      }
      let finalPath;
      let arg;
      if (targetFile) {
        finalPath = targetFile.replace(/\//g, '\\');
        arg = `/select,"${finalPath}"`;
      } else {
        const mediaDir = projectId ? path.join(projectDir(projectId), 'media') : DATA;
        if (!fsSync.existsSync(mediaDir)) {
          fsSync.mkdirSync(mediaDir, { recursive: true });
        }
        finalPath = mediaDir.replace(/\//g, '\\');
        arg = `"${finalPath}"`;
      }
      const p = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', `Start-Process explorer.exe -ArgumentList '${arg}'`], {
        windowsHide: true,
        stdio: 'ignore'
      });
      p.unref();
      return send(res, 200, { ok: true, path: finalPath, folder: finalPath });
    }
    if(req.method==='POST' && url.pathname==='/api/video/delete') {
      const body = await readJson(req);
      const projectId = safeId(body.projectId || body.id);
      const videoName = path.basename(String(body.videoName || body.name || ''));
      if(!videoName) return send(res, 400, { error: 'Tên tệp không hợp lệ.' });
      let deleted = false;
      if (projectId) {
        const p1 = path.join(projectDir(projectId), 'media', videoName);
        if (fsSync.existsSync(p1)) {
          await fs.unlink(p1).catch(() => {});
          deleted = true;
        }
      }
      if (!deleted) {
        const entries = await fs.readdir(DATA, { withFileTypes: true });
        for (const ent of entries) {
          if (ent.isDirectory()) {
            const p2 = path.join(DATA, ent.name, 'media', videoName);
            if (fsSync.existsSync(p2)) {
              await fs.unlink(p2).catch(() => {});
              deleted = true;
              break;
            }
          }
        }
      }
      return send(res, 200, { ok: true, deleted, name: videoName });
    }
    if(req.method==='POST' && url.pathname==='/api/upload') {
      const body=await readJson(req),id=safeId(body.id); if(!id) return send(res,400,{error:'Mã dự án không hợp lệ.'});
      const ext=String(body.extension||'').toLowerCase(); if(!['.png','.jpg','.jpeg','.webp','.wav','.mp3','.mp4','.mov'].includes(ext)) return send(res,400,{error:'Định dạng chưa hỗ trợ.'});
      const name=`${crypto.randomUUID()}${ext}`, bytes=Buffer.from(body.data||'','base64'); if(bytes.length>80_000_000) return send(res,413,{error:'Tệp tối đa 80 MB. Sử dụng luồng tải video để tải file lớn.'});
      const folder=['.png','.jpg','.jpeg','.webp','.mp4','.mov'].includes(ext)?'media':''; await fs.writeFile(path.join(projectDir(id),folder,name),bytes); return send(res,201,{name});
    }
    if(req.method==='POST' && url.pathname==='/api/speak') {
      const body=await readJson(req),id=safeId(body.id); if(!id) return send(res,400,{error:'Mã dự án không hợp lệ.'});
      const text=String(body.text||'').trim(); if(!text) return send(res,400,{error:'Nhập lời thoại trước.'});
      const engine=String(body.engine||'auto'), voiceName=String(body.voiceName||'');
      if(engine==='windows') {
        const wav=await synthesize(id,String(body.sceneId||''),text,voiceName);
        const dur = await getMediaDuration(path.join(projectDir(id),wav));
        return send(res,200,{voiceFile:wav,engine:'windows',duration:dur ? Math.ceil(dur) : null});
      }
      try {
        const r=await fetch(`http://127.0.0.1:${TTS_PORT}/synthesize`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,engine,voice:voiceName||null}),signal:AbortSignal.timeout(600000)});
        if(!r.ok) { const message=await r.text(); throw new Error(message||`TTS backend báo lỗi ${r.status}`); }
        const wav=`voice-${String(body.sceneId||'scene')}.wav`;
        const wavPath = path.join(projectDir(id),wav);
        await fs.writeFile(wavPath,Buffer.from(await r.arrayBuffer()));
        const dur = await getMediaDuration(wavPath);
        return send(res,200,{voiceFile:wav,engine,duration:dur ? Math.ceil(dur) : null});
      } catch(e) {
        if(engine==='auto' && process.platform==='win32') {
          const wav=await synthesize(id,String(body.sceneId||''),text,voiceName);
          const dur = await getMediaDuration(path.join(projectDir(id),wav));
          return send(res,200,{voiceFile:wav,engine:'windows-fallback',warning:e.message,duration:dur ? Math.ceil(dur) : null});
        }
        return send(res,503,{error:`TTS ${engine} chưa sẵn sàng. Hãy cài backend theo tts_backend/README.md. Chi tiết: ${e.message}`});
      }
    }
    if(req.method==='POST' && url.pathname==='/api/video/auto-silence-cut') {
      return send(res, 410, { error: 'Tính năng cắt khoảng lặng đã ngừng hỗ trợ. Vui lòng dùng tính năng Cắt phân đoạn hoặc Cắt theo kịch bản.' });
    }
    if(false) {

      const body=await readJson(req);
      const projectId=safeId(body.projectId || body.project_id);
      if(!projectId) return send(res,400,{error:'Mã dự án không hợp lệ.'});
      const videoName=String(body.videoName || body.video_name || '').trim();
      if(!videoName) return send(res,400,{error:'Tên tệp video không hợp lệ.'});

      const videoFile = await resolveVideoFile(projectId, videoName);
      if(!videoFile) return send(res,404,{error:'Không tìm thấy tệp video nguồn.'});
      const inputPath = videoFile.fullPath;
      const dir = projectDir(projectId);

      const useVad = body.engine !== 'ffmpeg'; // Mặc định sử dụng Silero VAD trừ khi chọn ffmpeg
      const noiseDb = Math.min(-10, Math.max(-60, Number(body.noiseDb || -35)));
      const minDuration = Math.max(0.2, Math.min(5.0, Number(body.minDuration || 0.4)));
      const taskId = String(body.taskId || '').trim();

      try {
        console.log(`[Auto Silence Cut] Bắt đầu quét khoảng lặng cho: ${videoFile.fileName} (VAD=${useVad}, minDur=${minDuration}s, taskId=${taskId})...`);
        const totalDur = await getMediaDuration(inputPath);
        if(!totalDur || totalDur <= 0) return send(res,400,{error:'Không xác định được thời lượng video.'});

        broadcastProgress(taskId, {
          step: 'vad',
          pct: 15,
          message: useVad ? '🧠 AI Silero VAD đang phát hiện giọng nói...' : '📻 FFmpeg đang đo mức âm lượng...',
          speed: ''
        });

        let keepSegments = [];
        let silences = [];

        // 1. Thử quét bằng Silero VAD (AI Deep Learning)
        if (useVad) {
          const pyBin = path.join(ROOT, '.venv-tts', 'Scripts', 'python.exe');
          const vadScript = path.join(ROOT, 'scripts', 'vad_detect.py');
          const tmpVadJson = path.join(dir, `vad_${Date.now()}.json`);
          try {
            console.log(`[Silero VAD] Đang chạy mô hình AI nhận diện giọng nói chính xác...`);
            await run(pyBin, [
              vadScript,
              '--input', inputPath,
              '--output_json', tmpVadJson,
              '--min_silence_ms', String(Math.round(minDuration * 1000)),
              '--speech_pad_ms', '150'
            ], { windowsHide: true, signal: clientAbort.signal });

            if (fsSync.existsSync(tmpVadJson)) {
              const vadData = JSON.parse(await fs.readFile(tmpVadJson, 'utf8'));
              await fs.unlink(tmpVadJson).catch(() => {});
              if (vadData.speech_segments && vadData.speech_segments.length > 0) {
                keepSegments = vadData.speech_segments.map(s => ({ start: s.start, end: s.end }));
                silences = vadData.silence_segments || [];
                console.log(`[Silero VAD] Thành công: Giữ lại ${keepSegments.length} phân đoạn lời nói sạch (${silences.length} khoảng lặng bị loại bỏ).`);
              }
            }
          } catch (vadErr) {
            if (clientAbort.signal.aborted) throw vadErr;
            console.warn('[Silero VAD Fallback]', vadErr.message, '-> Chuyển sang FFmpeg silencedetect');
          }
        }

        // 2. Dự phòng: Nếu VAD không tìm thấy hoặc tắt VAD thì dùng FFmpeg silencedetect
        if (keepSegments.length === 0) {
          const { err: silenceLogs } = await run(FFMPEG_BIN, [
            '-hide_banner',
            '-i', inputPath,
            '-vn',
            '-af', `silencedetect=noise=${noiseDb}dB:d=${minDuration}`,
            '-f', 'null', '-'
          ], { windowsHide: true, signal: clientAbort.signal });

          silences = [];
          let curStart = null;
          for (const line of (silenceLogs || '').split(/\r?\n/)) {
            if (line.includes('silence_start:')) {
              const m = line.match(/silence_start:\s*([\d.]+)/);
              if (m) curStart = parseFloat(m[1]);
            } else if (line.includes('silence_end:') && curStart !== null) {
              const m = line.match(/silence_end:\s*([\d.]+)/);
              if (m) {
                const curEnd = parseFloat(m[1]);
                silences.push({ start: curStart, end: curEnd, duration: curEnd - curStart });
                curStart = null;
              }
            }
          }
          if (curStart !== null && curStart < totalDur) {
            silences.push({ start: curStart, end: totalDur, duration: totalDur - curStart });
          }

          const speechPad = 0.15;
          let lastEnd = 0.0;
          for (const s of silences) {
            const segStart = lastEnd;
            const segEnd = Math.max(segStart, s.start + speechPad);
            if (segEnd - segStart >= 0.25) {
              keepSegments.push({ start: segStart, end: segEnd });
            }
            lastEnd = Math.min(totalDur, s.end - speechPad);
          }
          if (lastEnd < totalDur && (totalDur - lastEnd) >= 0.25) {
            keepSegments.push({ start: lastEnd, end: totalDur });
          }
          if (silences.length === 0) {
            return send(res, 200, {
              ok: true,
              outputVideo: `media/${videoFile.fileName}`,
              fileName: videoFile.fileName,
              originalDuration: totalDur,
              newDuration: totalDur,
              removedDuration: 0,
              silenceCount: 0,
              message: 'Video không có khoảng lặng nào vượt ngưỡng chỉ định.'
            });
          }
        }

        if (keepSegments.length === 0) {
          return send(res, 400, { error: 'Không tìm thấy phân đoạn lời nói hợp lệ trong video.' });
        }

        console.log(`[Auto Silence Cut] Sau khi gộp và đệm âm: còn ${keepSegments.length} phân đoạn lời nói sạch.`);

        // 3. Xây dựng filter_complex với aresample=async=1000 để khóa cứng đồng bộ mẫu âm thanh AAC
        const filterParts = [];
        const inLabels = [];
        keepSegments.forEach((seg, idx) => {
          const s = seg.start.toFixed(3);
          const e = seg.end.toFixed(3);
          filterParts.push(`[0:v]trim=start=${s}:end=${e},setpts=PTS-STARTPTS[v${idx}]`);
          filterParts.push(`[0:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS,aresample=async=1000[a${idx}]`);
          inLabels.push(`[v${idx}][a${idx}]`);
        });
        filterParts.push(`${inLabels.join('')}concat=n=${keepSegments.length}:v=1:a=1[outv][outa]`);

        const baseClean = videoFile.fileName.replace(/^(smart_cut_\d+_|silence_cut_\d+_|multicut_\d+_|pip_\d+_)+/g, '');
        const outName = `silence_cut_${Date.now()}_${baseClean}`;
        outputPath = path.join(dir, 'media', outName);

        // Ước tính tổng thời lượng của video đầu ra sau khi cắt
        const estOutputDur = keepSegments.reduce((acc, seg) => acc + (seg.end - seg.start), 0) || totalDur;

        broadcastProgress(taskId, {
          step: 'render_start',
          pct: 25,
          message: `🎬 Đang ghép & xuất ${keepSegments.length} phân đoạn qua GPU...`,
          speed: ''
        });

        const vEncoderArgs = await getFastEncoderArgs();
        const t0 = Date.now();
        let lastReportTime = 0;

        await run(FFMPEG_BIN, [
          '-y', '-hide_banner',
          '-i', inputPath,
          '-filter_complex', filterParts.join(';'),
          '-map', '[outv]', '-map', '[outa]',
          ...vEncoderArgs,
          '-c:a', 'aac', '-b:a', '192k',
          outputPath
        ], {
          cwd: dir,
          windowsHide: true,
          signal: clientAbort.signal,
          onProgress: ({ curSec, speedStr }) => {
            const now = Date.now();
            if (now - lastReportTime < 250) return; // Giới hạn 4 lần/giây để không nghẽn network
            lastReportTime = now;
            // Tiến trình render tính từ 25% -> 98%
            const renderRatio = Math.min(1.0, Math.max(0.0, curSec / (estOutputDur || 1)));
            const actualPct = Math.min(98, Math.round(25 + renderRatio * 73));
            
            // Tính số giây còn lại (ETA) dựa trên speed
            let etaSec = null;
            const speedMatch = (speedStr || '').match(/([\d.]+)x/);
            if (speedMatch && parseFloat(speedMatch[1]) > 0) {
              const speedVal = parseFloat(speedMatch[1]);
              const remainingVideoSec = Math.max(0, estOutputDur - curSec);
              etaSec = Math.max(0, Math.round(remainingVideoSec / speedVal));
            }

            broadcastProgress(taskId, {
              step: 'encoding',
              pct: actualPct,
              curSec: Math.round(curSec),
              totalSec: Math.round(estOutputDur),
              speed: speedStr || '',
              etaSec
            });
          }
        });
        const processMs = Date.now() - t0;

        broadcastProgress(taskId, {
          step: 'done',
          pct: 100,
          message: '✓ Hoàn tất!',
          etaSec: 0
        });

        const newDur = await getMediaDuration(outputPath);
        const removedDur = Math.max(0, (totalDur || 0) - (newDur || 0));

        console.log(`[Auto Silence Cut] Hoàn tất sau ${processMs}ms: ${totalDur.toFixed(1)}s -> ${newDur ? newDur.toFixed(1) : '?'}s (Cắt bỏ: ${removedDur.toFixed(1)}s).`);

        return send(res, 200, {
          ok: true,
          outputVideo: `media/${outName}`,
          fileName: outName,
          originalDuration: totalDur,
          newDuration: newDur,
          removedDuration: removedDur,
          silenceCount: silences.length,
          processTimeMs: processMs,
          keepSegmentsCount: keepSegments.length
        });
      } catch (err) {
        if (outputPath) await fs.unlink(outputPath).catch(() => {});
        if (clientAbort.signal.aborted) {
          console.log('[Auto Silence Cut] Đã dừng tác vụ theo yêu cầu người dùng.');
          return;
        }
        console.error('[Auto Silence Cut Error]', err);
        return send(res, 500, { error: `Lỗi xử lý cắt khoảng lặng: ${err.message}` });
      }
    }
    if(req.method==='POST' && url.pathname==='/api/video/smart-cut') {
      const clientAbort = new AbortController();
      res.on('close', () => { if (!res.writableEnded) clientAbort.abort(); });
      let outputPath = null;

      const body = await readJson(req);
      const projectId = safeId(body.projectId || body.project_id);
      if(!projectId) return send(res, 400, { error: 'Mã dự án không hợp lệ.' });
      const videoName = String(body.videoName || body.video_name || '').trim();
      if(!videoName) return send(res, 400, { error: 'Tên tệp video không hợp lệ.' });

      const videoFile = await resolveVideoFile(projectId, videoName);
      if(!videoFile) return send(res, 404, { error: 'Không tìm thấy tệp video nguồn.' });
      const inputPath = videoFile.fullPath;
      const dir = projectDir(projectId);

      const startSec = Math.max(0, Number(body.start || 0));
      const endSec = Number(body.end || 0);
      if(endSec > 0 && endSec <= startSec) {
        return send(res, 400, { error: 'Thời điểm kết thúc (Out) phải lớn hơn thời điểm bắt đầu (In).' });
      }

      const totalDur = (await getMediaDuration(inputPath)) || 0;
      const targetEnd = (endSec > 0 && endSec <= totalDur) ? endSec : totalDur;
      const cutDuration = Math.max(0.1, targetEnd - startSec);

      const isLossless = body.lossless === true || (body.lossless !== false && body.enhance !== true && (!body.targetRes || body.targetRes === 'original'));
      const targetRes = String(body.targetRes || 'original').toLowerCase();
      const enableSharpen = body.sharpen === true || body.sharpen === 'true';
      const enableColorBoost = body.colorBoost === true || body.colorBoost === 'true';

      const baseClean = videoFile.fileName.replace(/^(smart_cut_\d+_|silence_cut_\d+_|multicut_\d+_|pip_\d+_)+/g, '');
      const outName = `cut_${Date.now()}_${baseClean}`;
      outputPath = path.join(dir, 'media', outName);

      try {
        console.log(`[Video Cut] Cắt ${videoFile.fileName} (${startSec.toFixed(1)}s -> ${targetEnd.toFixed(1)}s, Lossless=${isLossless}, TargetRes=${targetRes}, Sharpen=${enableSharpen})...`);
        const t0 = Date.now();
        const enableDenoise = Boolean(body.denoise);
        let modeLabel = 'Lossless Stream Copy (100% Giữ nguyên gốc)';

        if (isLossless) {
          // 1. CẮT NGUYÊN GỐC KHÔNG NÉN LẠI (LOSSLESS) - 100% KHÔNG GIẢM CHẤT LƯỢNG
          if (enableDenoise) modeLabel = 'Cắt siêu tốc + Lọc sạch tạp âm & Khử tiếng bụp';
          const cutFadeOut = Math.max(0, cutDuration - 0.01).toFixed(3);
          const cutDenoiseFilter = [
            'aresample=async=1:first_pts=0',
            'highpass=f=80:poles=2',
            'afftdn=nr=10:nf=-45:tn=1:gs=5',
            'equalizer=f=3200:t=q:w=1.2:g=2.5',
            'afade=t=in:d=0.01',
            `afade=t=out:st=${cutFadeOut}:d=0.01`,
            'alimiter=limit=0.84:attack=5:release=150:level=0'
          ].join(',');

          const copyArgs = [
            '-y', '-hide_banner',
            '-ss', startSec.toString(),
            '-t', cutDuration.toString(),
            '-i', inputPath,
            '-map', '0:v:0',
            '-map', '0:a:0?',
            '-c:v', 'copy',
            ...(enableDenoise
              ? ['-af', cutDenoiseFilter, '-c:a', 'aac', '-b:a', '192k']
              : ['-c:a', 'copy']),
            '-avoid_negative_ts', 'make_zero',
            '-movflags', '+faststart',
            outputPath
          ];
          const copyTimeout = Math.max(120000, Math.round(cutDuration * 500));
          await run(FFMPEG_BIN, copyArgs, { cwd: dir, windowsHide: true, signal: clientAbort.signal, timeout: copyTimeout });
        } else {
          // 2. CẮT & TĂNG CHẤT LƯỢNG (NÂNG NÉT AMD CAS / NÂNG ĐỘ PHÂN GIẢI / LÀM TƯƠI MÀU)
          modeLabel = `Tăng chất lượng Studio (${targetRes.toUpperCase()})`;
          const vEncArgs = await getQualityEncoderArgs(targetRes, true);
          const meta = await getVideoStreamInfo(inputPath);

          let scaleW = meta.width;
          let scaleH = meta.height;
          if (targetRes === '4k') { scaleW = 3840; scaleH = 2160; }
          else if (targetRes === '2k') { scaleW = 2560; scaleH = 1440; }
          else if (targetRes === '1080p') { scaleW = 1920; scaleH = 1080; }
          else if (targetRes === '720p') { scaleW = 1280; scaleH = 720; }

          const vFilters = [];
          if (targetRes !== 'original') {
            vFilters.push(`scale=${scaleW}:${scaleH}:force_original_aspect_ratio=decrease,pad=${scaleW}:${scaleH}:(ow-iw)/2:(oh-ih)/2:color=black`);
          }
          if (enableColorBoost) {
            vFilters.push('eq=contrast=1.06:brightness=0.01:saturation=1.12');
          }
          if (enableSharpen) {
            vFilters.push('cas=strength=0.5:planes=1');
          }
          vFilters.push('setsar=1', 'fps=30', 'format=yuv420p');

          const aArgs = enableDenoise
            ? ['-af', 'highpass=f=80,afftdn=nr=14:nf=-25:tn=1', '-c:a', 'aac', '-b:a', '192k']
            : ['-c:a', 'aac', '-b:a', '192k'];

          const args = [
            '-y', '-hide_banner',
            '-ss', startSec.toString(),
            '-to', targetEnd.toString(),
            '-i', inputPath,
            '-vf', vFilters.join(','),
            ...vEncArgs,
            ...aArgs,
            '-movflags', '+faststart',
            outputPath
          ];
          const renderCutTimeout = Math.max(300000, Math.round(cutDuration * 3000));
          await run(FFMPEG_BIN, args, { cwd: dir, windowsHide: true, signal: clientAbort.signal, timeout: renderCutTimeout });
        }

        const processMs = Date.now() - t0;
        const newDur = (await getMediaDuration(outputPath)) || cutDuration;

        console.log(`[Video Cut] Hoàn tất sau ${processMs}ms (${modeLabel}, Thời lượng: ${newDur.toFixed(1)}s).`);

        return send(res, 200, {
          ok: true,
          outputVideo: `media/${outName}`,
          fileName: outName,
          originalDuration: totalDur,
          newDuration: newDur,
          start: startSec,
          end: targetEnd,
          mode: modeLabel,
          processTimeMs: processMs
        });
      } catch (err) {
        if (outputPath) await fs.unlink(outputPath).catch(() => {});
        if (clientAbort.signal.aborted) {
          console.log('[Video Cut] Đã dừng tác vụ theo yêu cầu người dùng.');
          return;
        }
        console.error('[Video Cut Error]', err);
        return send(res, 500, { error: `Lỗi cắt video: ${err.message}` });
      }
    }

    if(req.method==='POST' && url.pathname==='/api/video/denoise') {
      const clientAbort = new AbortController();
      res.on('close', () => { if (!res.writableEnded) clientAbort.abort(); });
      let outputPath = null;

      try {
        const body = await readJson(req);
        const projectId = safeId(body.projectId || body.project_id);
        if (!projectId) return send(res, 400, { error: 'Mã dự án không hợp lệ.' });
        const videoName = String(body.videoName || body.video_name || '').trim();
        if (!videoName) return send(res, 400, { error: 'Tên tệp video không hợp lệ.' });

        const videoFile = await resolveVideoFile(projectId, videoName);
        if (!videoFile) return send(res, 404, { error: 'Không tìm thấy tệp video nguồn.' });
        const inputPath = videoFile.fullPath;

        const outDir = path.join(DATA, projectId, 'media');
        await fs.mkdir(outDir, { recursive: true });
        const ts = Date.now();
        const baseName = path.parse(videoFile.fileName).name;
        const outFileName = `denoised_${ts}_${baseName}.mp4`;
        outputPath = path.join(outDir, outFileName);

        const totalDur = (await getMediaDuration(inputPath)) || 10;
        const fadeOutStart = Math.max(0, totalDur - 0.01).toFixed(3);
        const audioFilters = [
          'aresample=async=1:first_pts=0',
          'highpass=f=80:poles=2',
          'afftdn=nr=10:nf=-45:tn=1:gs=5',
          'equalizer=f=3200:t=q:w=1.2:g=2.5',
          'afade=t=in:d=0.01',
          `afade=t=out:st=${fadeOutStart}:d=0.01`,
          'alimiter=limit=0.84:attack=5:release=150:level=0'
        ].join(',');

        // Giữ nguyên 100% video gốc (-c:v copy), lọc sạch tiếng quạt, gió, triệt tiêu tiếng bụp và chống trùng đè âm thanh
        const ffmpegArgs = [
          '-y', '-hide_banner',
          '-i', inputPath,
          '-map', '0:v:0',
          '-map', '0:a:0?',
          '-c:v', 'copy',
          '-af', audioFilters,
          '-c:a', 'aac',
          '-b:a', '192k',
          '-avoid_negative_ts', 'make_zero',
          '-movflags', '+faststart',
          outputPath
        ];

        const tStart = Date.now();
        await new Promise((resolve, reject) => {
          const ff = spawn(FFMPEG_BIN, ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
          let stderr = '';
          ff.stderr.on('data', d => stderr += d.toString());
          ff.on('close', code => {
            if (code === 0) resolve();
            else reject(new Error(stderr || `FFmpeg thoát với mã lỗi ${code}`));
          });
          ff.on('error', reject);
          clientAbort.signal.addEventListener('abort', () => {
            try { ff.kill('SIGKILL'); } catch {}
          });
        });

        const procTime = Date.now() - tStart;
        const newDur = await getMediaDuration(outputPath).catch(() => 0);
        return send(res, 200, {
          ok: true,
          outputFile: outFileName,
          fileName: outFileName,
          downloadUrl: `/api/media/${projectId}/${outFileName}`,
          duration: newDur,
          processTimeMs: procTime
        });
      } catch (err) {
        if (outputPath) await fs.unlink(outputPath).catch(() => {});
        return send(res, 500, { error: 'Lỗi lọc tạp âm: ' + err.message });
      }
    }

    if(req.method==='POST' && url.pathname==='/api/video/multi-cut') {
      const clientAbort = new AbortController();
      res.on('close', () => { if (!res.writableEnded) clientAbort.abort(); });
      let outputPath = null;

      const body=await readJson(req);
      const projectId=safeId(body.projectId || body.project_id);
      if(!projectId) return send(res,400,{error:'Mã dự án không hợp lệ.'});
      const videoName=String(body.videoName || body.video_name || '').trim();
      if(!videoName) return send(res,400,{error:'Tên tệp video không hợp lệ.'});

      const videoFile = await resolveVideoFile(projectId, videoName);
      if(!videoFile) return send(res,404,{error:'Không tìm thấy tệp video nguồn.'});
      const inputPath = videoFile.fullPath;
      const dir = projectDir(projectId);

      const segments = Array.isArray(body.segments) ? body.segments : [];
      if(segments.length === 0) {
        return send(res, 400, { error: 'Cần ít nhất một khoảng cần cắt (segments).' });
      }

      const totalDur = (await getMediaDuration(inputPath)) || 0;
      const validSegments = [];
      for (const seg of segments) {
        const s = Math.max(0, Number(seg.start || 0));
        const e = Math.min(totalDur, Number(seg.end || totalDur));
        if (e - s >= 0.1) {
          validSegments.push({ start: s, end: e });
        }
      }

      if (validSegments.length === 0) {
        return send(res, 400, { error: 'Các khoảng cắt không hợp lệ (thời lượng mỗi đoạn cần >= 0.1s).' });
      }

      const baseClean = videoFile.fileName.replace(/^(smart_cut_\d+_|silence_cut_\d+_|multicut_\d+_|pip_\d+_)+/g, '');
      const outName = `multicut_${Date.now()}_${baseClean}`;
      outputPath = path.join(dir, 'media', outName);

      try {
        console.log(`[Multi Cut] Cắt & ghép ${validSegments.length} khoảng từ: ${videoFile.fileName}...`);
        const t0 = Date.now();

        const filterParts = [];
        const inLabels = [];
        validSegments.forEach((seg, idx) => {
          const s = seg.start.toFixed(3);
          const e = seg.end.toFixed(3);
          filterParts.push(`[0:v]trim=start=${s}:end=${e},setpts=PTS-STARTPTS[v${idx}]`);
          filterParts.push(`[0:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS[a${idx}]`);
          inLabels.push(`[v${idx}][a${idx}]`);
        });
        filterParts.push(`${inLabels.join('')}concat=n=${validSegments.length}:v=1:a=1[outv][outa]`);

        const vEncoderArgs = await getFastEncoderArgs();
        await run(FFMPEG_BIN, [
          '-y', '-hide_banner',
          '-i', inputPath,
          '-filter_complex', filterParts.join(';'),
          '-map', '[outv]', '-map', '[outa]',
          ...vEncoderArgs,
          '-c:a', 'aac', '-b:a', '192k',
          outputPath
        ], { cwd: dir, windowsHide: true, signal: clientAbort.signal });
        const processMs = Date.now() - t0;
        const newDur = await getMediaDuration(outputPath);

        console.log(`[Multi Cut] Hoàn tất sau ${processMs}ms (Thời lượng mới: ${newDur ? newDur.toFixed(1) : '?'}s).`);

        return send(res, 200, {
          ok: true,
          outputVideo: `media/${outName}`,
          fileName: outName,
          originalDuration: totalDur,
          newDuration: newDur,
          segmentsCount: validSegments.length,
          processTimeMs: processMs
        });
      } catch (err) {
        if (outputPath) await fs.unlink(outputPath).catch(() => {});
        if (clientAbort.signal.aborted) {
          console.log('[Multi Cut] Đã dừng tác vụ theo yêu cầu người dùng.');
          return;
        }
        console.error('[Multi Cut Error]', err);
        return send(res, 500, { error: `Lỗi cắt nhiều khoảng: ${err.message}` });
      }
    }
    if(req.method==='POST' && url.pathname==='/api/video/subtitles/generate') {
      const clientAbort = new AbortController();
      res.on('close', () => { if (!res.writableEnded) clientAbort.abort(); });
      let tmpWav = null, tmpJson = null, tmpSrt = null;

      const body = await readJson(req);
      const projectId = safeId(body.projectId || body.project_id);
      if(!projectId) return send(res, 400, { error: 'Mã dự án không hợp lệ.' });
      const videoName = String(body.videoName || body.video_name || '').trim();
      if(!videoName) return send(res, 400, { error: 'Tên tệp video không hợp lệ.' });

      const videoFile = await resolveVideoFile(projectId, videoName);
      if(!videoFile) return send(res, 404, { error: 'Không tìm thấy tệp video nguồn.' });
      const inputPath = videoFile.fullPath;
      const dir = projectDir(projectId);

      const language = String(body.language || 'vi').trim();
      const model = String(body.model || 'base').trim();

      tmpWav = path.join(dir, `sub_extract_${Date.now()}.wav`);
      tmpJson = path.join(dir, `sub_result_${Date.now()}.json`);
      tmpSrt = path.join(dir, `sub_result_${Date.now()}.srt`);

      try {
        console.log(`[Auto Subtitles] Đang trích xuất audio 16kHz từ: ${videoFile.fileName}...`);
        const t0 = Date.now();
        // 1. Trích xuất âm thanh sang WAV 16kHz Mono
        await run(FFMPEG_BIN, [
          '-y', '-hide_banner',
          '-i', inputPath,
          '-vn',
          '-ac', '1',
          '-ar', '16000',
          '-f', 'wav',
          tmpWav
        ], { windowsHide: true, signal: clientAbort.signal });

        // 2. Chạy Whisper transcribe bằng local python venv
        const pyBin = path.join(ROOT, '.venv-tts', 'Scripts', 'python.exe');
        const scriptPath = path.join(ROOT, 'scripts', 'transcribe.py');
        const mode = String(body.mode || 'speech');
        const torchLib = path.join(ROOT, '.venv-tts', 'Lib', 'site-packages', 'torch', 'lib');
        console.log(`[Auto Subtitles] Đang nhận diện giọng nói bằng Whisper (${model}, lang=${language}, mode=${mode})...`);

        await run(pyBin, [
          scriptPath,
          '--audio', tmpWav,
          '--output_json', tmpJson,
          '--output_srt', tmpSrt,
          '--model', model,
          '--language', language,
          '--mode', mode
        ], {
          windowsHide: true,
          signal: clientAbort.signal,
          env: {
            ...process.env,
            PATH: `${torchLib};${process.env.PATH || ''}`
          }
        });

        const resultRaw = await fs.readFile(tmpJson, 'utf8');
        const parsed = JSON.parse(resultRaw);
        const processMs = Date.now() - t0;

        console.log(`[Auto Subtitles] Hoàn tất sau ${processMs}ms: Nhận diện được ${parsed.segments?.length || 0} câu phụ đề.`);

        await fs.unlink(tmpWav).catch(() => {});
        await fs.unlink(tmpJson).catch(() => {});
        await fs.unlink(tmpSrt).catch(() => {});

        return send(res, 200, {
          ok: true,
          segments: parsed.segments || [],
          srt: parsed.srt || '',
          language: parsed.language || language,
          duration: parsed.duration || 0,
          processTimeMs: processMs
        });
      } catch (err) {
        if (tmpWav) await fs.unlink(tmpWav).catch(() => {});
        if (tmpJson) await fs.unlink(tmpJson).catch(() => {});
        if (tmpSrt) await fs.unlink(tmpSrt).catch(() => {});
        if (clientAbort.signal.aborted) {
          console.log('[Auto Subtitles] Đã dừng nhận diện giọng nói theo yêu cầu người dùng.');
          return;
        }
        console.error('[Auto Subtitles Error]', err);
        return send(res, 500, { error: `Lỗi nhận diện phụ đề: ${err.message}` });
      }
    }
    if(req.method==='POST' && url.pathname==='/api/video/subtitles/burn') {
      const clientAbort = new AbortController();
      res.on('close', () => { if (!res.writableEnded) clientAbort.abort(); });
      let outputPath = null;
      let srtPath = null;

      const body = await readJson(req);
      const projectId = safeId(body.projectId || body.project_id);
      if(!projectId) return send(res, 400, { error: 'Mã dự án không hợp lệ.' });
      const videoName = String(body.videoName || body.video_name || '').trim();
      if(!videoName) return send(res, 400, { error: 'Tên tệp video không hợp lệ.' });

      const videoFile = await resolveVideoFile(projectId, videoName);
      if(!videoFile) return send(res, 404, { error: 'Không tìm thấy tệp video nguồn.' });
      const inputPath = videoFile.fullPath;
      const dir = projectDir(projectId);

      let srtText = String(body.srtContent || '').trim();
      if (!srtText && Array.isArray(body.segments) && body.segments.length > 0) {
        const formatTs = sec => {
          const s = Number(sec) || 0;
          const h = Math.floor(s / 3600);
          const m = Math.floor((s % 3600) / 60);
          const sc = Math.floor(s % 60);
          const ms = Math.floor((s - Math.floor(s)) * 1000);
          return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
        };
        srtText = body.segments.map((seg, idx) => {
          return `${idx + 1}\n${formatTs(seg.start)} --> ${formatTs(seg.end)}\n${String(seg.text || '').trim()}\n`;
        }).join('\n');
      }

      if (!srtText) {
        return send(res, 400, { error: 'Nội dung phụ đề trống.' });
      }

      const isKaraoke = Boolean(body.karaoke);
      const colorScheme = String(body.colorScheme || 'capcut_yellow').toLowerCase();
      let primaryColor = '&H0076F1FF'; // Vàng chanh pastel CapCut Trending
      let secondaryColor = '&H00FFFFFF'; // Màu chờ hát (Trắng)
      let outlineColor = '&H00000000';
      let backColor = '&H80000000';
      let borderStyle = 1;
      let outlineWidth = 2.0;
      let shadow = 1;

      if (colorScheme === 'cinema_box') {
        primaryColor = '&H00FFFFFF';
        secondaryColor = '&H00A0A0A0';
        borderStyle = 3; // Hộp nền đen mờ
        backColor = '&H99000000';
        outlineWidth = 0;
        shadow = 0;
      } else if (colorScheme === 'kids_vibrant') {
        primaryColor = '&H0024D6FF'; // Vàng cam ấm
        secondaryColor = '&H00FFFFFF';
        outlineColor = '&H00102040';
        outlineWidth = 2.5;
        shadow = 1.5;
      } else if (colorScheme === 'clean_white') {
        primaryColor = '&H0000F5FF'; // Sáng vàng neon khi đọc đến
        secondaryColor = '&H00FFFFFF';
        outlineColor = '&H00000000';
        outlineWidth = 1.8;
        shadow = 1;
      } else if (colorScheme === 'neon_green') {
        primaryColor = '&H00D4F500'; // Xanh ngọc neon
        secondaryColor = '&H00FFFFFF';
        outlineColor = '&H00000000';
        outlineWidth = 2.0;
        shadow = 1;
      }

      const fontSize = Math.min(36, Math.max(16, Number(body.fontSize || 22)));
      const marginV = Math.min(80, Math.max(15, Number(body.marginV || 28)));

      let subFilter = '';

      if (isKaraoke && Array.isArray(body.segments) && body.segments.length > 0) {
        // --- CHẾ ĐỘ KARAOKE CHUYÊN NGHIỆP VỚI FILE .ASS ---
        const formatAssTime = sec => {
          const s = Math.max(0, Number(sec) || 0);
          const h = Math.floor(s / 3600);
          const m = Math.floor((s % 3600) / 60);
          const sc = Math.floor(s % 60);
          const cs = Math.floor((s - Math.floor(s)) * 100);
          return `${h}:${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
        };

        const assFileName = `sub_karaoke_${Date.now()}.ass`;
        srtPath = path.join(dir, assFileName);

        let assLines = [
          '[Script Info]',
          'ScriptType: v4.00+',
          'PlayResX: 1280',
          'PlayResY: 720',
          'ScaledBorderAndShadow: yes',
          '',
          '[V4+ Styles]',
          'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
          `Style: Karaoke,Segoe UI,${fontSize * 1.5},${primaryColor},${secondaryColor},${outlineColor},${backColor},-1,0,0,0,100,100,0,0,${borderStyle},${outlineWidth},${shadow},2,20,20,${marginV * 1.4},1`,
          '',
          '[Events]',
          'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
        ];

        body.segments.forEach(seg => {
          const segStart = Number(seg.start) || 0;
          const segEnd = Number(seg.end) || 0;
          if (segEnd <= segStart) return;

          let dialogueText = '';
          if (Array.isArray(seg.words) && seg.words.length > 0) {
            // Có mốc thời gian từng từ -> Dùng thẻ \k (centiseconds) để chữ sáng lên theo giọng đọc
            seg.words.forEach(w => {
              const wStart = Number(w.start) || segStart;
              const wEnd = Number(w.end) || segEnd;
              const durCs = Math.max(5, Math.round((wEnd - wStart) * 100));
              const wordStr = String(w.word || '').trim();
              if (wordStr) {
                dialogueText += `{\\k${durCs}}${wordStr} `;
              }
            });
            dialogueText = dialogueText.trim();
          } else {
            // Không có word_timestamps -> Chia đều thời gian theo số từ trong câu
            const words = String(seg.text || '').trim().split(/\s+/).filter(Boolean);
            const totalCs = Math.max(10, Math.round((segEnd - segStart) * 100));
            const eachCs = Math.max(5, Math.round(totalCs / Math.max(1, words.length)));
            words.forEach(w => {
              dialogueText += `{\\k${eachCs}}${w} `;
            });
            dialogueText = dialogueText.trim();
          }

          if (dialogueText) {
            assLines.push(`Dialogue: 0,${formatAssTime(segStart)},${formatAssTime(segEnd)},Karaoke,,0,0,0,,${dialogueText}`);
          }
        });

        await fs.writeFile(srtPath, assLines.join('\n'), 'utf8');
        subFilter = `ass=${assFileName}`;
      } else {
        // --- CHẾ ĐỘ PHỤ ĐỀ CAPCUT THÔNG THƯỜNG DÙNG .SRT ---
        let srtText = String(body.srtContent || '').trim();
        if (!srtText && Array.isArray(body.segments) && body.segments.length > 0) {
          const formatTs = sec => {
            const s = Number(sec) || 0;
            const h = Math.floor(s / 3600);
            const m = Math.floor((s % 3600) / 60);
            const sc = Math.floor(s % 60);
            const ms = Math.floor((s - Math.floor(s)) * 1000);
            return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
          };
          srtText = body.segments.map((seg, idx) => {
            return `${idx + 1}\n${formatTs(seg.start)} --> ${formatTs(seg.end)}\n${String(seg.text || '').trim()}\n`;
          }).join('\n');
        }

        if (!srtText) {
          return send(res, 400, { error: 'Nội dung phụ đề trống.' });
        }

        const srtFileName = `sub_${Date.now()}.srt`;
        srtPath = path.join(dir, srtFileName);
        await fs.writeFile(srtPath, srtText, 'utf8');

        const forceStyle = `Fontname=Segoe UI,Fontsize=${fontSize},Bold=1,PrimaryColour=${primaryColor},OutlineColour=${outlineColor},BorderStyle=${borderStyle},Outline=${outlineWidth},Shadow=${shadow},BackColour=${backColor},Alignment=2,MarginV=${marginV}`;
        subFilter = `subtitles=${srtFileName}:force_style='${forceStyle}'`;
      }

      const baseClean = videoFile.fileName.replace(/^(subtitled_\d+_|smart_cut_\d+_|silence_cut_\d+_|multicut_\d+_|pip_\d+_)+/g, '');
      const outName = `subtitled_${Date.now()}_${baseClean}`;
      outputPath = path.join(dir, 'media', outName);

      const taskId = String(body.taskId || '').trim();

      try {
        console.log(`[Burn Subtitles] Đang dập phụ đề (${isKaraoke ? 'KARAOKE SÁNG TỪNG TỪ' : 'CapCut tĩnh'}) vào: ${videoFile.fileName} (style=${colorScheme}, size=${fontSize}, taskId=${taskId})...`);
        const totalDur = await getMediaDuration(inputPath);
        const t0 = Date.now();
        const vEncoderArgs = await getFastEncoderArgs();
        let lastReportTime = 0;

        await run(FFMPEG_BIN, [
          '-y', '-hide_banner',
          '-i', inputPath,
          '-vf', subFilter,
          ...vEncoderArgs,
          '-c:a', 'aac', '-b:a', '192k',
          outputPath
        ], {
          cwd: dir,
          windowsHide: true,
          signal: clientAbort.signal,
          onProgress: ({ curSec, speedStr }) => {
            const now = Date.now();
            if (now - lastReportTime < 250) return;
            lastReportTime = now;
            const dur = totalDur || 1;
            const ratio = Math.min(1.0, Math.max(0.0, curSec / dur));
            const actualPct = Math.min(98, Math.round(5 + ratio * 93));

            let etaSec = null;
            const speedMatch = (speedStr || '').match(/([\d.]+)x/);
            if (speedMatch && parseFloat(speedMatch[1]) > 0) {
              const speedVal = parseFloat(speedMatch[1]);
              const remainingVideoSec = Math.max(0, dur - curSec);
              etaSec = Math.max(0, Math.round(remainingVideoSec / speedVal));
            }

            broadcastProgress(taskId, {
              step: 'encoding',
              pct: actualPct,
              curSec: Math.round(curSec),
              totalSec: Math.round(dur),
              speed: speedStr || '',
              etaSec
            });
          }
        });

        broadcastProgress(taskId, { step: 'done', pct: 100, message: '✓ Hoàn tất!', etaSec: 0 });

        const processMs = Date.now() - t0;
        const newDur = await getMediaDuration(outputPath);

        await fs.unlink(srtPath).catch(() => {});

        console.log(`[Burn Subtitles] Hoàn tất sau ${processMs}ms: Đã dập phụ đề vào video (${outName}).`);

        return send(res, 200, {
          ok: true,
          outputVideo: `media/${outName}`,
          fileName: outName,
          duration: newDur,
          processTimeMs: processMs,
          isKaraoke: isKaraoke
        });
      } catch (err) {
        if (outputPath) await fs.unlink(outputPath).catch(() => {});
        if (srtPath) await fs.unlink(srtPath).catch(() => {});
        if (clientAbort.signal.aborted) {
          console.log('[Burn Subtitles] Đã dừng dập phụ đề theo yêu cầu người dùng.');
          return;
        }
        console.error('[Burn Subtitles Error]', err);
        return send(res, 500, { error: `Lỗi dập phụ đề vào video: ${err.message}` });
      }
    }
    if(req.method==='POST' && url.pathname==='/api/video/text-cut') {
      const clientAbort = new AbortController();
      res.on('close', () => { if (!res.writableEnded) clientAbort.abort(); });
      let outputPath = null;

      const body = await readJson(req);
      const projectId = safeId(body.projectId || body.project_id);
      if(!projectId) return send(res, 400, { error: 'Mã dự án không hợp lệ.' });
      const videoName = String(body.videoName || body.video_name || '').trim();
      if(!videoName) return send(res, 400, { error: 'Tên tệp video không hợp lệ.' });

      const videoFile = await resolveVideoFile(projectId, videoName);
      if(!videoFile) return send(res, 404, { error: 'Không tìm thấy tệp video nguồn.' });
      const inputPath = videoFile.fullPath;
      const dir = projectDir(projectId);

      // Nhận danh sách các đoạn cần giữ lại (keepSegments: [{start, end}])
      const keepSegments = Array.isArray(body.keepSegments) ? body.keepSegments : [];
      if (keepSegments.length === 0) {
        return send(res, 400, { error: 'Danh sách các đoạn cần giữ lại trống.' });
      }

      const totalDur = (await getMediaDuration(inputPath)) || 0;
      const baseClean = videoFile.fileName.replace(/^(text_cut_\d+_|smart_cut_\d+_|silence_cut_\d+_)+/g, '');
      const outName = `text_cut_${Date.now()}_${baseClean}`;
      outputPath = path.join(dir, 'media', outName);

      try {
        console.log(`[Text-Based Cut] Bắt đầu cắt video theo kịch bản: ${keepSegments.length} phân đoạn...`);
        const t0 = Date.now();
        const vEncoderArgs = await getFastEncoderArgs();

        const filterParts = [];
        const inLabels = [];
        keepSegments.forEach((seg, idx) => {
          const s = Math.max(0, Number(seg.start || 0)).toFixed(3);
          const e = Math.min(totalDur, Number(seg.end || totalDur)).toFixed(3);
          filterParts.push(`[0:v]trim=start=${s}:end=${e},setpts=PTS-STARTPTS[v${idx}]`);
          filterParts.push(`[0:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS,aresample=async=1000[a${idx}]`);
          inLabels.push(`[v${idx}][a${idx}]`);
        });
        filterParts.push(`${inLabels.join('')}concat=n=${keepSegments.length}:v=1:a=1[outv][outa]`);

        await run(FFMPEG_BIN, [
          '-y', '-hide_banner',
          '-i', inputPath,
          '-filter_complex', filterParts.join(';'),
          '-map', '[outv]', '-map', '[outa]',
          ...vEncoderArgs,
          '-c:a', 'aac', '-b:a', '192k',
          outputPath
        ], { cwd: dir, windowsHide: true, signal: clientAbort.signal });

        const processMs = Date.now() - t0;
        const newDur = await getMediaDuration(outputPath);
        console.log(`[Text-Based Cut] Hoàn tất sau ${processMs}ms: Thời lượng mới ${newDur ? newDur.toFixed(1) : '?'}s`);

        return send(res, 200, {
          ok: true,
          outputVideo: `media/${outName}`,
          fileName: outName,
          originalDuration: totalDur,
          newDuration: newDur,
          segmentsCount: keepSegments.length,
          processTimeMs: processMs
        });
      } catch (err) {
        if (outputPath) await fs.unlink(outputPath).catch(() => {});
        if (clientAbort.signal.aborted) {
          console.log('[Text-Based Cut] Đã dừng cắt video theo kịch bản.');
          return;
        }
        console.error('[Text Cut Error]', err);
        return send(res, 500, { error: `Lỗi cắt video theo văn bản: ${err.message}` });
      }
    }
        // --- API TRÍCH XUẤT WAVEFORM PEAKS THỰC TẾ & BỘ NHỚ ĐỆM .PEAKS (AUDIO PEAK CACHE) ---
    if(req.method==='GET' && url.pathname==='/api/video/waveform-peaks') {
      const clientAbort = new AbortController();
      res.on('close', () => { if (!res.writableEnded) clientAbort.abort(); });
      try {
        const projectId = safeId(url.searchParams.get('projectId') || url.searchParams.get('id'));
        const videoName = String(url.searchParams.get('videoName') || url.searchParams.get('name') || '').trim();
        const points = Math.min(360, Math.max(60, Number(url.searchParams.get('points') || 180)));

        if (!projectId || !videoName) {
          return send(res, 400, { error: 'Thiếu projectId hoặc videoName.' });
        }

        const vf = await resolveVideoFile(projectId, videoName);
        if (!vf) return send(res, 404, { error: 'Không tìm thấy video nguồn.' });

        const dir = projectDir(projectId);
        const cacheFile = path.join(dir, 'media', `${vf.fileName}.peaks`);

        // A. Đọc từ bộ nhớ đệm Flat Binary / JSON nếu đã tồn tại (< 1ms)
        if (fsSync.existsSync(cacheFile)) {
          try {
            const raw = await fs.readFile(cacheFile, 'utf8');
            const cached = JSON.parse(raw);
            if (Array.isArray(cached) && cached.length > 0) {
              return send(res, 200, { ok: true, cached: true, peaks: cached, count: cached.length });
            }
          } catch {}
        }

        // B. Trích xuất âm thanh Float32 downsampled 1000Hz siêu tốc (< 200ms)
        console.log(`[Waveform Cache] Đang trích xuất sóng âm thực tế cho: ${vf.fileName}...`);
        const { spawn } = await import('child_process');
        const ffProc = spawn(FFMPEG_BIN, [
          '-hide_banner',
          '-i', vf.fullPath,
          '-vn', '-ac', '1', '-ar', '1000',
          '-f', 'f32le',
          'pipe:1'
        ], { windowsHide: true });

        const chunks = [];
        ffProc.stdout.on('data', d => chunks.push(d));

        await new Promise((resolve, reject) => {
          ffProc.on('close', code => (code === 0 || chunks.length > 0) ? resolve() : reject(new Error('FFmpeg exit code ' + code)));
          ffProc.on('error', reject);
        });

        const buf = Buffer.concat(chunks);
        const floats = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
        const numPeaks = points;
        const peaks = [];

        if (floats.length === 0) {
          for (let i = 0; i < numPeaks; i++) peaks.push(0.18);
        } else {
          const blockSize = Math.max(1, Math.floor(floats.length / numPeaks));
          let maxG = 0;
          for (let i = 0; i < numPeaks; i++) {
            let bMax = 0;
            const start = i * blockSize;
            const end = (i === numPeaks - 1) ? floats.length : start + blockSize;
            for (let j = start; j < end; j++) {
              const v = Math.abs(floats[j]);
              if (v > bMax) bMax = v;
            }
            peaks.push(bMax);
            if (bMax > maxG) maxG = bMax;
          }
          const factor = maxG > 0.001 ? 0.95 / maxG : 1.0;
          for (let i = 0; i < numPeaks; i++) {
            peaks[i] = Math.max(0.12, Math.min(0.95, Number((peaks[i] * factor).toFixed(3))));
          }
        }

        // Ghi vào file cache .peaks để các lần mở sau đọc ngay tức thì
        await fs.writeFile(cacheFile, JSON.stringify(peaks), 'utf8').catch(() => {});
        console.log(`[Waveform Cache] Đã lưu ${peaks.length} mốc sóng âm vào ${path.basename(cacheFile)}`);

        return send(res, 200, { ok: true, cached: false, peaks, count: peaks.length });
      } catch (err) {
        console.error('[Waveform Peaks Error]', err);
        return send(res, 500, { error: 'Lỗi trích xuất waveform: ' + err.message });
      }
    }

    if(req.method==='POST' && url.pathname==='/api/video/scene-detect') {
      const clientAbort = new AbortController();
      res.on('close', () => { if (!res.writableEnded) clientAbort.abort(); });
      try {
        const body = await readJson(req);
        const projectId = safeId(body.projectId || body.project_id);
        if(!projectId) return send(res, 400, { error: 'Mã dự án không hợp lệ.' });
        const videoName = String(body.videoName || body.video_name || '').trim();
        if(!videoName) return send(res, 400, { error: 'Tên tệp video không hợp lệ.' });

        const videoFile = await resolveVideoFile(projectId, videoName);
        if(!videoFile) return send(res, 404, { error: 'Không tìm thấy tệp video nguồn.' });
        const inputPath = videoFile.fullPath;
        const totalDuration = await getMediaDuration(inputPath);

        const threshold = Math.min(0.8, Math.max(0.1, Number(body.threshold || 0.35)));
        // Debounce 2.0s để gộp các frame đổi cảnh trong vòng 2s thành 1 mốc duy nhất, loại trừ hiệu ứng animation PowerPoint
        const minSceneDur = Math.min(10, Math.max(2.0, Number(body.minSceneDur || 2.0)));

        console.log(`[Scene Detection] Đang quét chuyển cảnh siêu tốc (50x-100x Realtime, scale=320:-1) cho: ${videoFile.fileName}...`);
        const t0 = Date.now();

        // Thu nhỏ về 320p giúp so sánh vector chuyển động cực nhanh (50x - 100x realtime), không xuất video (-f null -)
        const { err: ffmpegErr } = await run(FFMPEG_BIN, [
          '-hide_banner',
          '-i', inputPath,
          '-filter_complex', `scale=320:-1,select='gt(scene,${threshold})',showinfo`,
          '-f', 'null',
          '-'
        ], { windowsHide: true, signal: clientAbort.signal });

        // Phân tích pts_time từ output stderr của showinfo
        const transitionPoints = [];
        const regex = /pts_time:\s*([0-9.]+)/g;
        let match;
        while ((match = regex.exec(ffmpegErr)) !== null) {
          const pt = Number(parseFloat(match[1]).toFixed(2));
          if (pt > 0.2 && pt < totalDuration - 0.2) {
            const lastPt = transitionPoints[transitionPoints.length - 1];
            if (lastPt === undefined || (pt - lastPt) >= minSceneDur) {
              transitionPoints.push(pt);
            }
          }
        }

        // Tạo mảng danh sách các cảnh (scenes)
        const sceneBounds = [0, ...transitionPoints, Number(totalDuration.toFixed(2))];
        const scenes = [];
        for (let i = 0; i < sceneBounds.length - 1; i++) {
          const start = sceneBounds[i];
          const end = sceneBounds[i + 1];
          const dur = Number((end - start).toFixed(2));
          if (dur > 0.1) {
            scenes.push({
              id: i + 1,
              start,
              end,
              duration: dur,
              label: `Cảnh ${i + 1}: ${start}s - ${end}s`
            });
          }
        }

        const processMs = Date.now() - t0;
        console.log(`[Scene Detection] Quét xong sau ${processMs}ms: ${transitionPoints.length} điểm chuyển cảnh, ${scenes.length} phân đoạn slide.`);

        return send(res, 200, {
          ok: true,
          totalDuration,
          transitionPoints,
          scenes,
          processTimeMs: processMs
        });
      } catch (err) {
        if (clientAbort.signal.aborted) {
          console.log('[Scene Detection] Đã dừng quét cảnh theo yêu cầu người dùng.');
          return;
        }
        console.error('[Scene Detection Error]', err);
        return send(res, 500, { error: `Lỗi phát hiện cảnh: ${err.message}` });
      }
    }
    if(req.method==='POST' && url.pathname==='/api/video/audio/clean') {
      const clientAbort = new AbortController();
      res.on('close', () => { if (!res.writableEnded) clientAbort.abort(); });
      let outputPath = null;

      const body = await readJson(req);
      const projectId = safeId(body.projectId || body.project_id);
      if(!projectId) return send(res, 400, { error: 'Mã dự án không hợp lệ.' });

      const dir = projectDir(projectId);
      const rawVideo = String(body.videoName || body.videoSource || '').trim();
      if (!rawVideo) return send(res, 400, { error: 'Tên tệp video không hợp lệ.' });

      const videoFile = await resolveVideoFile(projectId, rawVideo);
      if(!videoFile) {
        return send(res, 404, { error: 'Không tìm thấy file video nguồn để lọc ồn.' });
      }

      const inputPath = videoFile.fullPath;
      const noiseLevel = String(body.noiseLevel || 'medium').toLowerCase();
      let nf = -25;
      if (noiseLevel === 'light') nf = -30;
      else if (noiseLevel === 'strong') nf = -20;

      const normalize = body.normalize !== false;
      const lowFreq = Math.max(20, Math.min(300, Number(body.lowFreq) || 95));
      const highFreq = Math.max(4000, Math.min(20000, Number(body.highFreq) || 12000));

      const filters = [
        `highpass=f=${lowFreq}`,
        `lowpass=f=${highFreq}`,
        'adeclick', // Triệt tiêu tiếng bụp bụp, lách tách màng mic
        `afftdn=nf=${nf}`
      ];
      if (normalize) {
        filters.push('dynaudnorm=f=150:g=15'); // Cân bằng giọng tự nhiên, ấm áp, tốc độ siêu tốc
      }
      filters.push('aresample=async=1000');
      const audioFilter = filters.join(',');

      const baseClean = videoFile.fileName.replace(/^(merged_\d+_|cleaned_\d+_|subtitled_\d+_|smart_cut_\d+_|silence_cut_\d+_|multicut_\d+_|pip_\d+_)+/g, '');
      const outName = `cleaned_${Date.now()}_${baseClean}`;
      outputPath = path.join(dir, 'media', outName);

      const taskId = String(body.taskId || '').trim();

      try {
        console.log(`[Voice Cleaner] Bắt đầu lọc ồn cho: ${videoFile.fileName} (level=${noiseLevel}, nf=${nf}, norm=${normalize}, taskId=${taskId})...`);
        const totalDur = await getMediaDuration(inputPath);
        const t0 = Date.now();
        let lastReportTime = 0;

        await run(FFMPEG_BIN, [
          '-y', '-hide_banner',
          '-i', inputPath,
          '-c:v', 'copy',
          '-af', audioFilter,
          '-c:a', 'aac', '-b:a', '192k',
          outputPath
        ], {
          cwd: dir,
          windowsHide: true,
          signal: clientAbort.signal,
          onProgress: ({ curSec, speedStr }) => {
            const now = Date.now();
            if (now - lastReportTime < 250) return;
            lastReportTime = now;
            const dur = totalDur || 1;
            const ratio = Math.min(1.0, Math.max(0.0, curSec / dur));
            const actualPct = Math.min(98, Math.round(5 + ratio * 93));

            let etaSec = null;
            const speedMatch = (speedStr || '').match(/([\d.]+)x/);
            if (speedMatch && parseFloat(speedMatch[1]) > 0) {
              const speedVal = parseFloat(speedMatch[1]);
              const remainingVideoSec = Math.max(0, dur - curSec);
              etaSec = Math.max(0, Math.round(remainingVideoSec / speedVal));
            }

            broadcastProgress(taskId, {
              step: 'encoding',
              pct: actualPct,
              curSec: Math.round(curSec),
              totalSec: Math.round(dur),
              speed: speedStr || '',
              etaSec
            });
          }
        });

        broadcastProgress(taskId, { step: 'done', pct: 100, message: '✓ Hoàn tất!', etaSec: 0 });

        const processMs = Date.now() - t0;
        const newDur = await getMediaDuration(outputPath);

        console.log(`[Voice Cleaner] Hoàn tất sau ${processMs}ms: Đã lọc sạch âm thanh & tiếng bụp (${outName}).`);

        return send(res, 200, {
          ok: true,
          outputVideo: `media/${outName}`,
          fileName: outName,
          duration: newDur,
          processTimeMs: processMs,
          settings: {
            noiseLevel,
            nf,
            normalize,
            lowFreq,
            highFreq
          }
        });
      } catch (err) {
        if (outputPath) await fs.unlink(outputPath).catch(() => {});
        if (clientAbort.signal.aborted) {
          console.log('[Voice Cleaner] Đã dừng lọc ồn theo yêu cầu người dùng.');
          return;
        }
        console.error('[Voice Cleaner Error]', err);
        return send(res, 500, { error: `Lỗi lọc ồn âm thanh: ${err.message}` });
      }
    }
    if(req.method==='POST' && url.pathname==='/api/video/concat') {
      const clientAbort = new AbortController();
      res.on('close', () => { if (!res.writableEnded) clientAbort.abort(); });
      let outputPath = null;

      const body = await readJson(req);
      const projectId = safeId(body.projectId || body.project_id);
      if(!projectId) return send(res, 400, { error: 'Mã dự án không hợp lệ.' });

      const dir = projectDir(projectId);
      const rawList = Array.isArray(body.videoNames) ? body.videoNames : [];
      if (rawList.length < 2) {
        return send(res, 400, { error: 'Cần ít nhất 2 video để ghép nối.' });
      }

      const resolvedFiles = [];
      for (const item of rawList) {
        const itemName = (typeof item === 'object' && item !== null) ? (item.name || item.fileName || '') : String(item || '').trim();
        const vf = await resolveVideoFile(projectId, itemName);
        if (!vf) {
          return send(res, 404, { error: `Không tìm thấy tệp video: ${itemName}` });
        }
        const tStart = (typeof item === 'object' && item !== null && Number(item.trimStart) > 0) ? Number(item.trimStart) : 0;
        const tEnd = (typeof item === 'object' && item !== null && Number(item.trimEnd) > 0) ? Number(item.trimEnd) : 0;
        resolvedFiles.push({
          ...vf,
          trimStart: tStart,
          trimEnd: tEnd
        });
      }

      const outName = `merged_${Date.now()}_capcut.mp4`;
      outputPath = path.join(dir, 'media', outName);
      const listTxtPath = path.join(dir, `concat_list_${Date.now()}.txt`);

      try {
        const t0 = Date.now();
        console.log(`[Video Concat] Bắt đầu ghép ${resolvedFiles.length} video...`);
        const transition = String(body.transition || 'cut').toLowerCase();
        const vEncoderArgs = await getFastEncoderArgs();

        // 1. Phân tích chi tiết metadata (resolution, aspect ratio, SAR, duration, audio) của TẤT CẢ các clip
        const metaList = [];
        let totalExpectedDur = 0;
        let has1080p = false;
        let hasAnyTrimming = false;

        for (const f of resolvedFiles) {
          const meta = await getVideoStreamInfo(f.fullPath);
          const dur = (await getMediaDuration(f.fullPath)) || meta.duration || 0;
          meta.realDuration = dur;
          meta.hasAudio = await hasAudioStream(f.fullPath);

          let actualStart = Math.max(0, f.trimStart || 0);
          let actualEnd = (f.trimEnd > actualStart && f.trimEnd <= dur) ? f.trimEnd : dur;
          if (actualStart >= actualEnd) {
            actualStart = 0;
            actualEnd = dur;
          }
          const isTrimmed = (actualStart > 0.05) || (actualEnd < dur - 0.05);
          if (isTrimmed) hasAnyTrimming = true;

          f.actualStart = actualStart;
          f.actualEnd = actualEnd;
          f.effectiveDur = Math.max(0.1, actualEnd - actualStart);
          totalExpectedDur += f.effectiveDur;

          if (meta.width >= 1920 || meta.height >= 1080) has1080p = true;
          metaList.push(meta);
        }

        // Chọn khung hình chuẩn 16:9 (1920x1080 nếu có clip 1080p+, hoặc 1280x720)
        // Tất cả các video khi ghép đều được đưa về canvas này với letterbox/pillarbox đệm đen, KHÔNG BAO GIỜ BỊ MÉO
        let targetW = 1920; let targetH = 1080;
        const reqRes = String(body.targetRes || (has1080p ? '1080p' : '720p')).toLowerCase();
        if (reqRes === '4k') { targetW = 3840; targetH = 2160; }
        else if (reqRes === '2k') { targetW = 2560; targetH = 1440; }
        else if (reqRes === '720p') { targetW = 1280; targetH = 720; }
        else { targetW = 1920; targetH = 1080; }

        // 2. PHÂN TÍCH CHỮ KÝ VÀ LẬP KẾ HOẠCH NỐI CHUẨN ĐÍCH (PRE-FLIGHT SIGNATURE & PLANNER)
        let plannerResult = null;
        try {
          const filePaths = resolvedFiles.map(f => f.fullPath);
          const sigs = await getSignaturesBatch(filePaths, FFPROBE_BIN, run, fsSync.statSync, 4);
          const trims = resolvedFiles.map(f => ({ trimStart: f.actualStart, trimEnd: f.actualEnd }));
          plannerResult = planConcatWorkflow(sigs, { transition, forceEncode: body.forceEncode === true, trims });
          if (plannerResult) {
            console.log(`[Video Concat Planner] Chiến lược: ${plannerResult.strategy} - ${plannerResult.reason}`);
          }
        } catch (planErr) {
          console.warn('[Video Concat Planner] Bỏ qua bộ lập kế hoạch:', planErr.message);
        }

        if (plannerResult && plannerResult.strategy === 'ABORT') {
          return send(res, 400, { error: plannerResult.reason });
        }

        // 3. ƯU TIÊN SỐ 1: FAST STREAM COPY SIÊU TỐC (2-4 GIÂY CHO 80+ CLIP)
        // Khi người dùng nối thẳng (transition === 'cut') và không ép render lại
        const forceEncode = body.forceEncode === true || (['fade', 'wipeleft', 'circleopen', 'dissolve'].includes(transition)) || plannerResult?.strategy === 'FULL_2STAGE_RENDER';
        let copySuccess = false;

        if (!forceEncode) {
          const tempNormalizedFiles = [];
          try {
            console.log(`[Video Concat] Bắt đầu Fast Stream Copy siêu tốc cho ${resolvedFiles.length} clip...`);

            // GIAI ĐOẠN 0: Chuẩn hóa riêng các clip lệch âm thanh / chèn câm nếu cần
            const clipFileMap = new Map();
            if (plannerResult?.strategy === 'NORMALIZE_CLIPS_THEN_COPY' && Array.isArray(plannerResult.clipActions)) {
              for (const act of plannerResult.clipActions) {
                const normPath = path.join(dir, 'media', `norm_audio_${act.index}_${Date.now()}.mp4`);
                tempNormalizedFiles.push(normPath);
                const tStart = act.trimStart || 0;
                const tEnd = act.trimEnd || 99999;

                const clipDur = Math.max(1, tEnd - tStart);
                const normTimeout = Math.max(180000, Math.round(clipDur * 1000));

                if (act.audio?.type === 'INJECT_SILENCE') {
                  // Chèn luồng câm 48kHz stereo cho clip không tiếng
                  await run(FFMPEG_BIN, [
                    '-y', '-hide_banner', '-stats',
                    '-ss', tStart.toString(), '-to', tEnd.toString(),
                    '-i', act.filePath,
                    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
                    '-map', '0:v:0', '-map', '1:a:0',
                    '-c:v', 'copy', '-c:a', 'aac', '-profile:a', 'aac_low',
                    '-shortest', '-avoid_negative_ts', 'make_zero',
                    normPath
                  ], { cwd: dir, windowsHide: true, signal: clientAbort.signal, timeout: normTimeout });
                  clipFileMap.set(act.index, normPath);
                } else if (act.audio?.type === 'RESAMPLE_AUDIO') {
                  // Chuẩn hóa audio về AAC 48kHz stereo, giữ nguyên video
                  await run(FFMPEG_BIN, [
                    '-y', '-hide_banner', '-stats',
                    '-ss', tStart.toString(), '-to', tEnd.toString(),
                    '-i', act.filePath,
                    '-map', '0:v:0', '-map', '0:a:0',
                    '-c:v', 'copy', '-c:a', 'aac', '-profile:a', 'aac_low',
                    '-b:a', '192k', '-ar', '48000', '-ac', '2',
                    '-af', 'aresample=async=1:first_pts=0',
                    '-avoid_negative_ts', 'make_zero',
                    normPath
                  ], { cwd: dir, windowsHide: true, signal: clientAbort.signal, timeout: normTimeout });
                  clipFileMap.set(act.index, normPath);
                }
              }
            }

            const listLines = [];
            for (let idx = 0; idx < resolvedFiles.length; idx++) {
              const f = resolvedFiles[idx];
              if (clipFileMap.has(idx)) {
                // Đã chuẩn hóa audio kèm cắt in/out trong Giai đoạn 0
                const nPath = clipFileMap.get(idx);
                listLines.push(`file '${nPath.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
              } else {
                listLines.push(`file '${f.fullPath.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
                if (f.actualStart > 0.05) {
                  listLines.push(`inpoint ${f.actualStart.toFixed(3)}`);
                }
                if (f.actualEnd < (f.realDuration || 99999) - 0.05) {
                  listLines.push(`outpoint ${f.actualEnd.toFixed(3)}`);
                }
              }
            }

            await fs.writeFile(listTxtPath, listLines.join('\n'), 'utf8');
            const streamCopyTimeout = Math.max(300000, Math.round(totalExpectedDur * 1000));
            await run(FFMPEG_BIN, [
              '-y', '-hide_banner',
              '-stats',
              '-f', 'concat', '-safe', '0',
              '-i', listTxtPath,
              '-c', 'copy',
              '-avoid_negative_ts', 'make_zero',
              '-movflags', '+faststart',
              outputPath
            ], { cwd: dir, windowsHide: true, signal: clientAbort.signal, timeout: streamCopyTimeout });
            await fs.unlink(listTxtPath).catch(() => {});

            // Dọn dẹp các tệp tạm Giai đoạn 0
            for (const tmp of tempNormalizedFiles) {
              await fs.unlink(tmp).catch(() => {});
            }

            const verifyDur = await getMediaDuration(outputPath);
            if (verifyDur && verifyDur > 0.5) {
              copySuccess = true;
              console.log(`[Video Concat] Fast Stream Copy siêu tốc THÀNH CÔNG (${verifyDur.toFixed(1)}s, ${resolvedFiles.length} clip)!`);
            } else {
              console.warn('[Video Concat] Stream copy không khả dụng, chuyển sang chế độ GPU Render...');
              await fs.unlink(outputPath).catch(() => {});
            }
          } catch (copyErr) {
            console.log(`[Video Concat] Stream copy gặp lỗi: ${copyErr.message}. Chuyển sang GPU render...`);
            for (const tmp of tempNormalizedFiles) {
              await fs.unlink(tmp).catch(() => {});
            }
            await fs.unlink(outputPath).catch(() => {});
          }
        }

        // 3. NẾU CẦN RENDER (LÀM NÉT AMD CAS / NÂNG ĐỘ PHÂN GIẢI / CHUYỂN CẢNH):
        // Tối ưu hóa cực đại cho Laptop văn phòng:
        if (!copySuccess) {
          const hasTransition = ['fade', 'wipeleft', 'circleopen', 'dissolve'].includes(transition);
          const transDur = hasTransition ? 0.75 : 0;
          const xfadeTrans = transition === 'dissolve' ? 'fade' : transition;

          // Nếu chỉ cần Nối thẳng + Làm nét CAS hoặc Nâng độ phân giải: DÙNG CHIẾN LƯỢC 2 BƯỚC SIÊU TỐC
          // Bước 1: Nối không nén bằng Concat Demuxer ra file tạm (2-3 giây)
          // Bước 2: Nâng nét AMD CAS từ đúng 1 file tạm duy nhất (Laptop xử lý cực nhanh, không bao giờ nghẽn RAM)
          if (!hasTransition) {
            console.log(`[Video Concat] Áp dụng 2-Stage Pipeline tối ưu cho Laptop: Ghép ${resolvedFiles.length} clip...`);
            const tempMergedPath = path.join(dir, 'media', `temp_concat_${Date.now()}.mp4`);
            const listLines = [];
            for (const f of resolvedFiles) {
              listLines.push(`file '${f.fullPath.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
              if (f.actualStart > 0.05) listLines.push(`inpoint ${f.actualStart.toFixed(3)}`);
              if (f.actualEnd < (f.realDuration || 99999) - 0.05) listLines.push(`outpoint ${f.actualEnd.toFixed(3)}`);
            }
            await fs.writeFile(listTxtPath, listLines.join('\n'), 'utf8');

            // Bước 1: Ghép tạm siêu tốc (Stream Copy)
            const tempMergeTimeout = Math.max(300000, Math.round(totalExpectedDur * 1000));
            await run(FFMPEG_BIN, [
              '-y', '-hide_banner', '-stats',
              '-f', 'concat', '-safe', '0',
              '-i', listTxtPath,
              '-c', 'copy',
              '-avoid_negative_ts', 'make_zero',
              '-movflags', '+faststart',
              tempMergedPath
            ], { cwd: dir, windowsHide: true, signal: clientAbort.signal, timeout: tempMergeTimeout });
            await fs.unlink(listTxtPath).catch(() => {});

            // Bước 2: Nâng nét CAS & Độ phân giải từ file tạm (Chỉ 1 input duy nhất, GPU/CPU chạy mượt 100%)
            const vEncArgs = await getQualityEncoderArgs(reqRes, true);
            const vfList = [];
            if (reqRes !== 'original') {
              vfList.push(`scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2:color=black`);
            }
            if (body.sharpen !== false) {
              vfList.push('cas=strength=0.45:planes=1');
            }
            vfList.push('setsar=1', 'fps=30', 'format=yuv420p');

            const renderTimeout = Math.max(300000, Math.round(totalExpectedDur * 3000));
            await run(FFMPEG_BIN, [
              '-y', '-hide_banner', '-stats',
              '-i', tempMergedPath,
              '-vf', vfList.join(','),
              ...vEncArgs,
              '-c:a', 'copy',
              '-movflags', '+faststart',
              outputPath
            ], { cwd: dir, windowsHide: true, signal: clientAbort.signal, timeout: renderTimeout });

            await fs.unlink(tempMergedPath).catch(() => {});
          } else {
            // Trường hợp có hiệu ứng chuyển cảnh xfade (fade, wipeleft, circle)
            console.log(`[Video Concat] Render chuyển cảnh (${transition}) ${resolvedFiles.length} clip...`);
            const cmdArgs = ['-y', '-hide_banner'];
            resolvedFiles.forEach(f => cmdArgs.push('-i', f.fullPath));

            const filterParts = [];
            resolvedFiles.forEach((f, idx) => {
              const isTrimmed = (f.actualStart > 0.05) || (f.actualEnd < metaList[idx].realDuration - 0.05);
              if (isTrimmed) {
                filterParts.push(`[${idx}:v]trim=start=${f.actualStart.toFixed(3)}:end=${f.actualEnd.toFixed(3)},setpts=PTS-STARTPTS,scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p[v${idx}];`);
                if (metaList[idx].hasAudio) {
                  filterParts.push(`[${idx}:a]atrim=start=${f.actualStart.toFixed(3)}:end=${f.actualEnd.toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a${idx}];`);
                } else {
                  filterParts.push(`aevalsrc=0:d=${f.effectiveDur.toFixed(3)}:s=48000:c=stereo[a${idx}];`);
                }
              } else {
                filterParts.push(`[${idx}:v]scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p,setpts=PTS-STARTPTS[v${idx}];`);
                if (metaList[idx].hasAudio) {
                  filterParts.push(`[${idx}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${idx}];`);
                } else {
                  filterParts.push(`aevalsrc=0:d=${metaList[idx].realDuration.toFixed(3)}:s=48000:c=stereo[a${idx}];`);
                }
              }
            });

            let lastV = 'v0';
            let lastA = 'a0';
            let curOffset = Math.max(0.1, resolvedFiles[0].effectiveDur - transDur);

            for (let i = 1; i < resolvedFiles.length; i++) {
              const outV = (i === resolvedFiles.length - 1) ? 'vmerged' : `vx${i}`;
              const outA = (i === resolvedFiles.length - 1) ? 'aout' : `ax${i}`;
              filterParts.push(`[${lastV}][v${i}]xfade=transition=${xfadeTrans}:duration=${transDur}:offset=${curOffset.toFixed(2)}[${outV}];`);
              filterParts.push(`[${lastA}][a${i}]acrossfade=d=${transDur}[${outA}];`);
              lastV = outV;
              lastA = outA;
              if (i < resolvedFiles.length - 1) {
                curOffset += Math.max(0.1, resolvedFiles[i].effectiveDur - transDur);
              }
            }

            if (body.sharpen !== false) {
              filterParts.push(`[vmerged]cas=strength=0.45:planes=1[vout]`);
            } else {
              filterParts.push(`[vmerged]null[vout]`);
            }

            const complexFilter = filterParts.join('');
            const vEncoderArgs = await getFastEncoderArgs();

            await run(FFMPEG_BIN, [
              ...cmdArgs,
              '-filter_complex', complexFilter,
              '-map', '[vout]',
              '-map', '[aout]',
              ...vEncoderArgs,
              '-c:a', 'aac', '-b:a', '192k',
              '-movflags', '+faststart',
              outputPath
            ], { cwd: dir, windowsHide: true, signal: clientAbort.signal, timeout: Math.max(300000, totalExpectedDur * 1500) });
          }
        }

        await fs.unlink(listTxtPath).catch(() => {});
        const processMs = Date.now() - t0;
        const totalDur = (await getMediaDuration(outputPath)) || totalExpectedDur;

        console.log(`[Video Concat] Ghép thành công ${resolvedFiles.length} clip sau ${processMs}ms (${outName}, thời lượng: ${totalDur.toFixed(1)}s, độ phân giải: ${targetW}x${targetH}).`);

        return send(res, 200, {
          ok: true,
          outputVideo: `media/${outName}`,
          fileName: outName,
          duration: totalDur,
          processTimeMs: processMs,
          count: resolvedFiles.length,
          resolution: `${targetW}x${targetH}`
        });
      } catch (err) {
        await fs.unlink(listTxtPath).catch(() => {});
        if (outputPath) await fs.unlink(outputPath).catch(() => {});
        if (clientAbort.signal.aborted) {
          console.log('[Video Concat] Đã dừng ghép video theo yêu cầu người dùng.');
          return;
        }
        console.error('[Video Concat Error]', err);
        return send(res, 500, { error: `Lỗi ghép video: ${err.message}` });
      }
    }
    if(req.method==='POST' && url.pathname==='/api/video/pip') {
      const clientAbort = new AbortController();
      res.on('close', () => { if (!res.writableEnded) clientAbort.abort(); });
      let outputPath = null;

      const body = await readJson(req);
      const projectId = safeId(body.projectId || body.project_id);
      if(!projectId) return send(res, 400, { error: 'Mã dự án không hợp lệ.' });

      const mainVideoName = String(body.mainVideo || body.videoName || '').trim();
      const pipVideoName = String(body.pipVideo || body.cameraVideo || '').trim();
      if(!mainVideoName || !pipVideoName) {
        return send(res, 400, { error: 'Cần chỉ định cả video chính (mainVideo) và video camera (pipVideo).' });
      }

      const mainFile = await resolveVideoFile(projectId, mainVideoName);
      const pipFile = await resolveVideoFile(projectId, pipVideoName);
      if(!mainFile) return send(res, 404, { error: `Không tìm thấy video chính: ${mainVideoName}` });
      if(!pipFile) return send(res, 404, { error: `Không tìm thấy video camera PiP: ${pipVideoName}` });

      const dir = projectDir(projectId);
      const baseClean = mainFile.fileName.replace(/^(pip_\d+_|merged_\d+_|cleaned_\d+_|smart_cut_\d+_)+/g, '');
      const outName = `pip_${Date.now()}_${baseClean}`;
      outputPath = path.join(dir, 'media', outName);

      const position = String(body.position || 'bottom-right').toLowerCase();
      const pipWidthRatio = Math.max(0.15, Math.min(0.5, Number(body.pipWidthRatio || 0.28)));
      const margin = Math.max(10, Math.min(100, Number(body.margin || 24)));

      try {
        console.log(`[Video PiP] Bắt đầu ghép PiP camera (${pipFile.fileName}) vào video (${mainFile.fileName}), vị trí=${position}...`);
        const t0 = Date.now();
        const vEncoderArgs = await getFastEncoderArgs();

        const pipW = Math.round(1280 * pipWidthRatio / 2) * 2;
        const pipH = Math.round(720 * pipWidthRatio / 2) * 2;

        let overlayCoord = `main_w-overlay_w-${margin}:main_h-overlay_h-${margin}`;
        if (position === 'bottom-left') overlayCoord = `${margin}:main_h-overlay_h-${margin}`;
        else if (position === 'top-right') overlayCoord = `main_w-overlay_w-${margin}:${margin}`;
        else if (position === 'top-left') overlayCoord = `${margin}:${margin}`;

        const mainHasAudio = await hasAudioStream(mainFile.fullPath);
        const pipHasAudio = await hasAudioStream(pipFile.fullPath);

        const filterParts = [
          `[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p,setpts=PTS-STARTPTS[mainv]`,
          `[1:v]scale=${pipW}:${pipH}:force_original_aspect_ratio=decrease,pad=${pipW}:${pipH}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p,setpts=PTS-STARTPTS[pipv_raw]`,
          `[pipv_raw]drawbox=x=0:y=0:w=${pipW}:h=${pipH}:color=white@0.9:t=3[pipv]`,
          `[mainv][pipv]overlay=${overlayCoord}:shortest=1[vout]`
        ];

        let mapAudioArgs = [];
        if (mainHasAudio && pipHasAudio) {
          filterParts.push(`[0:a]volume=0.8,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[a0]`);
          filterParts.push(`[1:a]volume=1.2,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[a1]`);
          filterParts.push(`[a0][a1]amix=inputs=2:duration=first:dropout_transition=2[aout]`);
          mapAudioArgs = ['-map', '[aout]', '-c:a', 'aac', '-b:a', '192k'];
        } else if (pipHasAudio) {
          mapAudioArgs = ['-map', '1:a', '-c:a', 'aac', '-b:a', '192k'];
        } else if (mainHasAudio) {
          mapAudioArgs = ['-map', '0:a', '-c:a', 'aac', '-b:a', '192k'];
        } else {
          filterParts.push(`anullsrc=r=48000:cl=stereo[aout]`);
          mapAudioArgs = ['-map', '[aout]', '-c:a', 'aac', '-b:a', '128k', '-shortest'];
        }

        const taskId = String(body.taskId || '').trim();
        const mainDur = await getMediaDuration(mainFile.fullPath);
        let lastReportTime = 0;

        await run(FFMPEG_BIN, [
          '-y', '-hide_banner',
          '-i', mainFile.fullPath,
          '-i', pipFile.fullPath,
          '-filter_complex', filterParts.join(';'),
          '-map', '[vout]',
          ...mapAudioArgs,
          ...vEncoderArgs,
          outputPath
        ], {
          cwd: dir,
          windowsHide: true,
          signal: clientAbort.signal,
          onProgress: ({ curSec, speedStr }) => {
            const now = Date.now();
            if (now - lastReportTime < 250) return;
            lastReportTime = now;
            const dur = mainDur || 1;
            const ratio = Math.min(1.0, Math.max(0.0, curSec / dur));
            const actualPct = Math.min(98, Math.round(5 + ratio * 93));

            let etaSec = null;
            const speedMatch = (speedStr || '').match(/([\d.]+)x/);
            if (speedMatch && parseFloat(speedMatch[1]) > 0) {
              const speedVal = parseFloat(speedMatch[1]);
              const remainingVideoSec = Math.max(0, dur - curSec);
              etaSec = Math.max(0, Math.round(remainingVideoSec / speedVal));
            }

            broadcastProgress(taskId, {
              step: 'encoding',
              pct: actualPct,
              curSec: Math.round(curSec),
              totalSec: Math.round(dur),
              speed: speedStr || '',
              etaSec
            });
          }
        });

        broadcastProgress(taskId, { step: 'done', pct: 100, message: '✓ Hoàn tất!', etaSec: 0 });

        const processMs = Date.now() - t0;
        const totalDur = await getMediaDuration(outputPath);

        console.log(`[Video PiP] Hoàn tất sau ${processMs}ms: ${outName} (${totalDur ? totalDur.toFixed(1) : '?'}s)`);
        return send(res, 200, {
          ok: true,
          outputVideo: `media/${outName}`,
          fileName: outName,
          duration: totalDur,
          processTimeMs: processMs
        });
      } catch (err) {
        if (outputPath) await fs.unlink(outputPath).catch(() => {});
        if (clientAbort.signal.aborted) {
          console.log('[Video PiP] Đã dừng xử lý PiP theo yêu cầu người dùng.');
          return;
        }
        console.error('[Video PiP Error]', err);
        return send(res, 500, { error: `Lỗi ghép PiP: ${err.message}` });
      }
    }
    if(req.method==='POST' && url.pathname==='/api/video/generate') {
      const body=await readJson(req);
      const projectId=safeId(body.projectId || body.project_id);
      if(!projectId) return send(res,400,{error:'Mã dự án không hợp lệ.'});
      const sceneId=body.sceneId || body.scene_id;
      if(!sceneId) return send(res,400,{error:'Mã cảnh không hợp lệ.'});
      const prompt=String(body.prompt||'').trim();
      if(!prompt) return send(res,400,{error:'Nhập mô tả (prompt) cho cảnh video.'});

      try {
        const r = await fetch(`http://127.0.0.1:${TTS_PORT}/generate-scene-video`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_id: projectId,
            scene_id: String(sceneId),
            prompt: prompt,
            image_path: body.imagePath || body.image_path || null,
            negative_prompt: body.negativePrompt || body.negative_prompt || null,
            steps: Number(body.steps) || 20,
            engine: body.engine || 'local',
            model: body.model || (body.engine === 'ltx' ? 'ltx' : 'wan'),
            width: Number(body.width) || 960,
            height: Number(body.height) || 544,
            length: Number(body.length) || 81
          }),
          signal: AbortSignal.timeout(10000)
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          const msg = data.error || data.detail || `AI backend trả về mã lỗi ${r.status}`;
          return send(res, r.status, { error: msg });
        }
        return send(res, r.status, data);
      } catch(err) {
        return send(res, 502, { error: `Không thể kết nối tới AI backend: ${err.message}` });
      }
    }
    if(req.method==='POST' && url.pathname==='/api/video/slide') {
      const body=await readJson(req);
      const projectId=safeId(body.projectId || body.project_id);
      if(!projectId) return send(res,400,{error:'Mã dự án không hợp lệ.'});
      const sceneId=body.sceneId || body.scene_id;
      if(!sceneId) return send(res,400,{error:'Mã cảnh không hợp lệ.'});
      const text=String(body.text||'').trim();
      if(!text) return send(res,400,{error:'Nhập nội dung cho slide.'});

      try {
        const r = await fetch(`http://127.0.0.1:${TTS_PORT}/generate-slide-video`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_id: projectId,
            scene_id: String(sceneId),
            text: text,
            style: body.style || 'title',
            duration: Number(body.duration) || 6,
            width: Number(body.width) || 960,
            height: Number(body.height) || 544
          }),
          signal: AbortSignal.timeout(10000)
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          const msg = data.error || data.detail || `AI backend trả về mã lỗi ${r.status}`;
          return send(res, r.status, { error: msg });
        }
        return send(res, r.status, data);
      } catch(err) {
        return send(res, 502, { error: `Không thể kết nối tới AI backend: ${err.message}` });
      }
    }
    if(req.method==='GET' && url.pathname==='/api/video/ltx-status') {
      try {
        const r = await fetch(`http://127.0.0.1:${TTS_PORT}/video/ltx-status`, {
          signal: AbortSignal.timeout(5000)
        });
        const data = await r.json().catch(() => ({}));
        return send(res, r.status, data);
      } catch(err) {
        return send(res, 502, { error: `Không thể kết nối tới AI backend: ${err.message}` });
      }
    }
    if(req.method==='GET' && url.pathname.startsWith('/api/video/status/')) {
      const taskId = url.pathname.split('/')[4];
      if(!taskId) return send(res,400,{error:'Thiếu taskId.'});
      try {
        const r = await fetch(`http://127.0.0.1:${TTS_PORT}/video-status/${encodeURIComponent(taskId)}`, {
          signal: AbortSignal.timeout(5000)
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          const msg = data.error || data.detail || `AI backend trả về mã lỗi ${r.status}`;
          return send(res, r.status, { error: msg });
        }
        return send(res, r.status, data);
      } catch(err) {
        return send(res, 502, { error: `Không thể kết nối tới AI backend: ${err.message}` });
      }
    }
    if(req.method==='POST' && url.pathname==='/api/video/lip-sync') {
      const body=await readJson(req);
      const projectId=safeId(body.projectId || body.project_id);
      if(!projectId) return send(res,400,{error:'Mã dự án không hợp lệ.'});
      try {
        const r = await fetch(`http://127.0.0.1:${TTS_PORT}/lip-sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_id: projectId,
            scene_id: body.sceneId || body.scene_id,
            video_path: body.videoPath || body.video_path,
            audio_path: body.audioPath || body.audio_path,
            mouth_x_pct: Number(body.mouth_x_pct || 0.50),
            mouth_y_pct: Number(body.mouth_y_pct || 0.58),
            mouth_scale_pct: Number(body.mouth_scale_pct || 0.20)
          }),
          signal: AbortSignal.timeout(60000)
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          const msg = data.error || data.detail || `Lip Sync trả về mã lỗi ${r.status}`;
          return send(res, r.status, { error: msg });
        }
        return send(res, r.status, data);
      } catch(err) {
        return send(res, 502, { error: `Không thể kết nối tới AI backend: ${err.message}` });
      }
    }
    if((req.method==='POST' || req.method==='GET') && url.pathname==='/api/vram/free') {
      try {
        const r = await fetch(`http://127.0.0.1:${TTS_PORT}/free-vram`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(5000)
        });
        const data = await r.json().catch(() => ({ ok: true }));
        return send(res, 200, { ok: true, detail: data });
      } catch(err) {
        return send(res, 200, { ok: true, message: 'Bộ nhớ cục bộ đã được dọn sạch.' });
      }
    }
    if(req.method==='POST' && url.pathname==='/api/ai-engine/start') {
      try {
        const r = await fetch(`http://127.0.0.1:${TTS_PORT}/ai-engine/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(90000)
        });
        const data = await r.json();
        return send(res, r.status, data);
      } catch(err) {
        return send(res, 502, { error: `Không thể kết nối tới AI backend: ${err.message}` });
      }
    }
    if(req.method==='POST' && url.pathname==='/api/ai-engine/stop') {
      try {
        const r = await fetch(`http://127.0.0.1:${TTS_PORT}/ai-engine/stop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(10000)
        });
        const data = await r.json();
        return send(res, r.status, data);
      } catch(err) {
        return send(res, 502, { error: `Không thể kết nối tới AI backend: ${err.message}` });
      }
    }
    if(req.method==='GET' && url.pathname==='/api/cloud/settings') {
      try {
        const r = await fetch(`http://127.0.0.1:${TTS_PORT}/cloud/settings`, { signal: AbortSignal.timeout(15000) });
        return send(res, r.status, await r.json());
      } catch(e) {
        return send(res, 502, { error: 'Không thể lấy cấu hình Cloud AI: ' + e.message });
      }
    }
    if(req.method==='POST' && url.pathname==='/api/cloud/settings') {
      const body = await readJson(req);
      if(body.veo_provider === 'google') body.veo_provider = 'gemini';
      try {
        const r = await fetch(`http://127.0.0.1:${TTS_PORT}/cloud/settings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15000)
        });
        return send(res, r.status, await r.json());
      } catch(e) {
        return send(res, 502, { error: 'Không thể lưu cấu hình Cloud AI: ' + e.message });
      }
    }
    if(req.method==='POST' && url.pathname==='/api/cloud/test-elevenlabs') {
      const body = await readJson(req);
      try {
        const r = await fetch(`http://127.0.0.1:${TTS_PORT}/cloud/test-elevenlabs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15000)
        });
        return send(res, r.status, await r.json());
      } catch(e) {
        return send(res, 502, { error: 'Lỗi kiểm tra ElevenLabs: ' + e.message });
      }
    }
    if(req.method==='POST' && url.pathname==='/api/cloud/test-veo') {
      const body = await readJson(req);
      if(body.provider === 'google') body.provider = 'gemini';
      try {
        const r = await fetch(`http://127.0.0.1:${TTS_PORT}/cloud/test-veo`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15000)
        });
        return send(res, r.status, await r.json());
      } catch(e) {
        return send(res, 502, { error: 'Lỗi kiểm tra Google Veo: ' + e.message });
      }
    }
    if(req.method==='GET' && url.pathname==='/api/cloud/elevenlabs/voices') {
      try {
        const r = await fetch(`http://127.0.0.1:${TTS_PORT}/cloud/elevenlabs/voices`, { signal: AbortSignal.timeout(15000) });
        return send(res, r.status, await r.json());
      } catch(e) {
        return send(res, 502, { error: 'Lỗi lấy danh sách giọng ElevenLabs: ' + e.message });
      }
    }
    if(req.method==='POST' && url.pathname==='/api/render') {
      const body=await readJson(req);
      try {
        const result=await render(body);
        await fs.writeFile(path.join(projectDir(body.id),'project.json'),JSON.stringify({...body,updatedAt:new Date().toISOString()},null,2));
        return send(res,200,result);
      } catch (err) {
        console.error('[Render Error]', err.message);
        return send(res, 400, { error: err.message });
      }
    }
    if(req.method==='GET' && url.pathname.startsWith('/projects/')) {
      const parts=url.pathname.split('/').filter(Boolean);
      const id=safeId(parts[1]);
      if(!id) return send(res,404,'Not found','text/plain');
      const relPath=parts.slice(2).map(decodeURIComponent).join('/');
      if(!relPath) return send(res,404,'Not found','text/plain');
      const safeRel = path.normalize(relPath).replace(/^(\.\.[\/\\])+/, '');
      const full = path.join(projectDir(id), safeRel);
      if(!full.startsWith(projectDir(id))) return send(res,403,'Forbidden','text/plain');
      try {
        const stat=await fs.stat(full);
        if(!stat.isFile()) return send(res,404,'Not found','text/plain');
        const range = req.headers.range;
        const contentType = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
        if (range) {
          const rparts = range.replace(/bytes=/, "").split("-");
          const start = parseInt(rparts[0], 10);
          const end = rparts[1] ? parseInt(rparts[1], 10) : stat.size - 1;
          const chunksize = (end - start) + 1;
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': contentType,
          });
          const stream = fsSync.createReadStream(full, { start, end });
          stream.on('error', () => { try { if (!res.writableEnded) res.end(); } catch {} });
          return stream.pipe(res);
        } else {
          res.writeHead(200, {
            'Content-Length': stat.size,
            'Content-Type': contentType,
            'Accept-Ranges': 'bytes'
          });
          const stream = fsSync.createReadStream(full);
          stream.on('error', () => { try { if (!res.writableEnded) res.end(); } catch {} });
          return stream.pipe(res);
        }
      } catch {
        return send(res,404,'Not found','text/plain');
      }
    }
    // SSE Real-time Progress Stream
    if(req.method==='GET' && url.pathname==='/api/progress/events') {
      const taskId = url.searchParams.get('taskId');
      if (!taskId) return send(res, 400, { error: 'Missing taskId' });

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      res.write(`data: ${JSON.stringify({ type: 'connected', taskId })}\n\n`);

      registerProgressClient(taskId, res);

      const heartbeat = setInterval(() => {
        try {
          if (!res.writableEnded) res.write(': heartbeat\n\n');
        } catch {}
      }, 15000);

      req.on('close', () => {
        clearInterval(heartbeat);
        unregisterProgressClient(taskId, res);
      });
      return;
    }
    if(req.method==='GET' || req.method==='HEAD') {
      const relPath = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
      const cleanRel = path.normalize(relPath).replace(/^(\.\.[\/\\])+/, '');
      const file = path.join(ROOT, 'public', cleanRel);
      if (file.startsWith(path.join(ROOT, 'public'))) {
        try {
          const stat = await fs.stat(file);
          if (stat.isFile()) {
            const ext = path.extname(file).toLowerCase();
            const mimeType = MIME[ext] || 'application/octet-stream';
            res.writeHead(200, {
              'Content-Type': mimeType,
              'Content-Length': stat.size,
              'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400'
            });
            const stream = fsSync.createReadStream(file);
            stream.on('error', () => { try { if (!res.writableEnded) res.end(); } catch {} });
            return stream.pipe(res);
          }
        } catch {}
      }
      return send(res, 404, 'Not found', 'text/plain');
    }
    send(res,404,{error:'Không tìm thấy.'});
  } catch(e) {
    if (!res.headersSent) send(res,500,{error:e.message||'Có lỗi khi xử lý yêu cầu.'});
  }
});
let ttsChild = null;

function launchTtsBackend() {
  const candidatePackaged = [
    path.join(ROOT, 'dist', 'tts-backend', 'tts-backend.exe'),
    path.join(ROOT, 'tts-backend', 'tts-backend.exe'),
    path.join(ROOT, 'runtime', 'tts-backend.exe'),
    path.join(ROOT, 'tts-backend.exe'),
  ];
  const localPython = process.env.TTS_PYTHON || path.join(ROOT, '.venv-tts', 'Scripts', 'python.exe');

  console.log('[Backend] Đang khởi động TTS & Video AI engine...');

  fs.access(localPython).then(() => {
    console.log('[Backend] Phát hiện Python venv local:', localPython);
    const child = spawn(localPython, ['-m', 'uvicorn', 'tts_backend.app:app', '--host', '127.0.0.1', '--port', String(TTS_PORT), '--no-access-log', '--log-level', 'warning'], {
      windowsHide: true,
      stdio: 'inherit',
      cwd: ROOT,
      env: { ...process.env, APP_ROOT: ROOT, TTS_PORT: String(TTS_PORT), PYTHONPATH: ROOT, HF_HOME: path.join(DATA, '_models') }
    });
    ttsChild = child;
    child.on('error', e => console.warn('[Backend] Lỗi khi chạy Python local:', e.message));
  }).catch(async () => {
    let foundPackaged = null;
    for (const p of candidatePackaged) {
      try {
        await fs.access(p);
        foundPackaged = p;
        break;
      } catch {}
    }

    if (!foundPackaged) {
      console.warn('[Backend] CẢNH BÁO: Không tìm thấy tts-backend.exe hoặc Python venv.');
      return;
    }

    console.log('[Backend] Chạy backend độc lập:', foundPackaged);
    const child = spawn(foundPackaged, [], {
      windowsHide: true,
      stdio: 'inherit',
      cwd: ROOT,
      env: { ...process.env, APP_ROOT: ROOT, TTS_PORT: String(TTS_PORT), PYTHONPATH: ROOT, HF_HOME: path.join(DATA, '_models') }
    });
    ttsChild = child;
    child.on('error', e => console.warn('[Backend] Lỗi khi chạy tts-backend.exe:', e.message));
  });
}

async function cleanupAndExit() {
  console.log('\n[Vườn Bài Giảng] Đang dừng hệ thống và dọn dẹp tiến trình...');
  try {
    await fetch(`http://127.0.0.1:${TTS_PORT}/ai-engine/stop`, {
      method: 'POST',
      signal: AbortSignal.timeout(2000),
    });
  } catch {}
  if (ttsChild && ttsChild.pid) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/F', '/T', '/PID', String(ttsChild.pid)], { windowsHide: true });
      } else {
        ttsChild.kill('SIGTERM');
      }
    } catch {}
  }
  process.exit(0);
}

process.on('SIGINT', cleanupAndExit);
process.on('SIGTERM', cleanupAndExit);
process.on('uncaughtException', (err) => {
  if (err && (err.code === 'ERR_HTTP_HEADERS_SENT' || err.code === 'ECONNRESET' || err.code === 'EPIPE')) {
    return;
  }
  console.error('[Backend UncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  console.warn('[Backend UnhandledRejection]', reason);
});

// // launchTtsBackend(); // Da go bo TTS AI de toi uu dung luong
server.listen(PORT,'127.0.0.1',()=>console.log(`Tool Tạo Video đang chạy: http://127.0.0.1:${PORT}`));
