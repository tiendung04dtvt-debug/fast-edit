import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT || 4196);
const BASE = `http://127.0.0.1:${PORT}`;
const NODE = process.execPath;
const FFMPEG = path.join(ROOT, 'runtime', 'ffmpeg.exe');
const FFPROBE = path.join(ROOT, 'runtime', 'ffprobe.exe');
const PROTECTED_ID = '6a6021d9-9563-4e7e-a25f-c9b9bfce22c7';
let projectId;
let projectDir;
let startedServer;
const results = [];

function run(bin, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${path.basename(bin)} timeout ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-12000); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${path.basename(bin)} exit=${code}: ${stderr}`));
    });
  });
}

async function api(route, body) {
  const response = await fetch(`${BASE}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(180000)
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 800) }; }
  return { status: response.status, data };
}

async function waitServer() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/projects`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Server unavailable: ${BASE}`);
}

async function ensureServer() {
  try {
    const response = await fetch(`${BASE}/api/projects`, { signal: AbortSignal.timeout(500) });
    if (response.ok) return;
  } catch {}
  startedServer = spawn(NODE, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, windowsHide: true, stdio: 'ignore'
  });
  await waitServer();
}

async function probe(filePath) {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=width,height,sample_aspect_ratio:stream_side_data=side_data_type,rotation',
    '-of', 'json', filePath
  ]);
  const data = JSON.parse(stdout);
  const stream = data.streams?.[0];
  assert.ok(stream, `No video stream in ${filePath}`);
  const matrix = stream.side_data_list?.find(item => item.side_data_type === 'Display Matrix');
  return { width: stream.width, height: stream.height, rotation: matrix?.rotation ?? 0, sar: stream.sample_aspect_ratio };
}

try {
  await ensureServer();
  const created = await api('/api/projects', { title: 'Codex orientation QA temporary' });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  projectId = created.data.id;
  assert.match(projectId, /^[a-f0-9-]{36}$/i);
  assert.notEqual(projectId, PROTECTED_ID);
  projectDir = path.join(ROOT, 'projects', projectId);
  const mediaDir = path.join(projectDir, 'media');
  await fs.mkdir(mediaDir, { recursive: true });

  const landscape = path.join(mediaDir, 'qa-landscape-16x9.mp4');
  const phone = path.join(mediaDir, 'qa-phone-display-matrix-90.mp4');
  const phoneBase = path.join(mediaDir, 'qa-phone-base.mp4');
  await run(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-threads', '1', '-g', '24', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', landscape
  ]);
  await run(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=2', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-threads', '1', '-g', '24', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', phoneBase
  ]);
  // FFmpeg 9 reads Display Matrix on the input; remux without re-encoding to make a phone-style rotated MP4.
  await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-display_rotation:v:0', '90', '-i', phoneBase, '-c', 'copy', phone]);
  const sourceMeta = await probe(phone);
  assert.equal(sourceMeta.width, 640);
  assert.equal(sourceMeta.height, 360);
  assert.ok(Math.abs(sourceMeta.rotation) === 90, `Fixture lacks 90-degree Display Matrix: ${JSON.stringify(sourceMeta)}`);

  const cut = await api('/api/video/smart-cut', { projectId, videoName: path.basename(phone), start: 0, end: 1.5, lossless: true });
  assert.equal(cut.status, 200, JSON.stringify(cut.data));
  const cutMeta = await probe(path.join(mediaDir, cut.data.fileName));
  results.push({ name: 'Cut giữ Display Matrix', status: Math.abs(cutMeta.rotation) === 90 ? 'PASS' : 'FAIL', details: `${sourceMeta.width}x${sourceMeta.height} rot=${sourceMeta.rotation} -> ${cutMeta.width}x${cutMeta.height} rot=${cutMeta.rotation}` });

  const concat = await api('/api/video/concat', {
    projectId,
    videoNames: [path.basename(phone), path.basename(landscape)],
    transition: 'fade', targetRes: '720p', forceEncode: true, sharpen: false
  });
  assert.equal(concat.status, 200, JSON.stringify(concat.data));
  const concatPath = path.join(mediaDir, concat.data.fileName);
  const concatMeta = await probe(concatPath);
  const dimensionsOk = concatMeta.width === 1280 && concatMeta.height === 720;
  results.push({ name: 'Ghép 9:16 có Display Matrix với clip 16:9', status: dimensionsOk && concatMeta.rotation === 0 ? 'PASS' : 'FAIL', details: `output=${concatMeta.width}x${concatMeta.height} rot=${concatMeta.rotation}; response=${concat.data.resolution}; ${concat.data.duration?.toFixed?.(3)}s` });

  console.log(`SOURCE_ROTATION ${JSON.stringify(sourceMeta)}`);
  console.log(`CUT_ROTATION ${JSON.stringify(cutMeta)}`);
  console.log(`CONCAT_OUTPUT ${JSON.stringify(concatMeta)}`);
} catch (error) {
  results.push({ name: 'Orientation QA', status: 'FAIL', details: error.stack || error.message });
} finally {
  if (projectDir && projectId && projectId !== PROTECTED_ID) {
    const root = path.resolve(ROOT, 'projects');
    const target = path.resolve(projectDir);
    if (path.dirname(target) === root) await fs.rm(target, { recursive: true, force: true }).catch(error => results.push({ name: 'Cleanup', status: 'FAIL', details: error.message }));
  }
  if (startedServer && !startedServer.killed) startedServer.kill();
  for (const result of results) console.log(`${result.status.padEnd(5)} ${result.name} — ${result.details}`);
  const failed = results.filter(result => result.status === 'FAIL').length;
  console.log(`RESULT ${results.length - failed}/${results.length} PASS`);
  if (failed) process.exitCode = 1;
}
