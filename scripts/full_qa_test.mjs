import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.env.APP_ROOT || path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const { buildLesson } = await import(pathToFileURL(path.join(ROOT, 'fastEditAudio.mjs')).href);
const PORT = Number(process.env.PORT || 4193);
const BASE = `http://127.0.0.1:${PORT}`;
const NODE = process.execPath;
const FFMPEG = path.join(ROOT, 'runtime', 'ffmpeg.exe');
const results = [];
let projectId = null;
let projectDir = null;
let startedServer = null;

async function waitForServer() {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    try {
      const response = await fetch(`${BASE}/api/projects`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error(`Server không phản hồi tại ${BASE}`);
}

async function ensureServer() {
  try {
    const response = await fetch(`${BASE}/api/projects`, { signal: AbortSignal.timeout(1000) });
    if (response.ok) return;
  } catch {}
  startedServer = spawn(NODE, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    windowsHide: true,
    stdio: 'ignore'
  });
  await waitForServer();
}

async function api(route, body, timeoutMs = 180000) {
  const response = await fetch(`${BASE}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
  return {
    status: response.status,
    data,
    videoListCache: response.headers.get('x-video-list-cache'),
    serverTiming: response.headers.get('server-timing')
  };
}

async function runProcess(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${path.basename(bin)} exit ${code}: ${stderr}`)));
  });
}

async function check(name, fn) {
  const started = Date.now();
  try {
    const details = await fn();
    results.push({ name, status: 'PASS', ms: Date.now() - started, details: String(details || 'OK') });
  } catch (error) {
    results.push({ name, status: 'FAIL', ms: Date.now() - started, details: error.message });
  }
}

function record(name, status, details) {
  results.push({ name, status, ms: 0, details });
}

async function postVideo(route, body, predicate = data => data.ok === true || Boolean(data.fileName)) {
  const response = await api(route, body);
  assert.equal(response.status, 200, `HTTP ${response.status}: ${JSON.stringify(response.data)}`);
  assert.ok(predicate(response.data), JSON.stringify(response.data));
  return response.data;
}

try {
  await ensureServer();
  await check('Trang ứng dụng', async () => {
    const response = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Fast Edit/i);
    return 'HTTP 200';
  });

  const created = await api('/api/projects', { title: 'Codex QA tạm' });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  projectId = created.data.id;
  assert.match(projectId, /^[a-f0-9-]{36}$/i);
  projectDir = path.join(ROOT, 'projects', projectId);
  await fs.mkdir(path.join(projectDir, 'media'), { recursive: true });

  const sourcePath = path.join(projectDir, 'media', 'qa_source.mp4');
  const cameraPath = path.join(projectDir, 'media', 'qa_camera.mp4');
  const fixtureArgs = (color, output) => [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=15:d=6`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=6',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-threads', '1', '-g', '15', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '64k', '-shortest', output
  ];
  await runProcess(FFMPEG, fixtureArgs('0x244477', sourcePath));
  await runProcess(FFMPEG, fixtureArgs('0x337744', cameraPath));
  let uploadedName = null;
  await check('Tải video lên project QA tạm', async () => {
    const bytes = await fs.readFile(sourcePath);
    const response = await api('/api/upload', { id: projectId, extension: '.mp4', data: bytes.toString('base64') });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    uploadedName = response.data.name;
    assert.ok(uploadedName);
    return `${uploadedName}; ${bytes.length} bytes`;
  });
  if (uploadedName) {
    await check('Xóa media QA vừa tải lên', async () => {
      const response = await api('/api/video/delete', { projectId, videoName: uploadedName });
      assert.equal(response.status, 200, JSON.stringify(response.data));
      assert.equal(response.data.deleted, true);
      return 'đã xóa đúng tệp test';
    });
  }

  await check('Lấy dự án QA tạm', async () => {
    const response = await api(`/api/projects/${projectId}`);
    assert.equal(response.status, 200);
    assert.equal(response.data.id, projectId);
    return projectId;
  });

  await check('Lưu và duyệt kịch bản dự án', async () => {
    const project = { id: projectId, title: 'Codex QA tạm - đã lưu', ratio: '16:9', resolution: '720p', scenes: [{ id: 'qa', text: 'Kiem tra luu du an', duration: 2 }] };
    const saved = await api('/api/save', project);
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.equal(saved.data.project.script_approved, false, 'sửa kịch bản phải yêu cầu duyệt lại');
    const approved = await api(`/api/projects/${projectId}/approve-script`, {});
    assert.equal(approved.status, 200, JSON.stringify(approved.data));
    assert.equal(approved.data.script_approved, true);
    return 'lưu + duyệt lại thành công';
  });

  await check('Đọc thư viện video và thời lượng', async () => {
    const response = await api(`/api/video/list?id=${projectId}`);
    assert.equal(response.status, 200);
    assert.equal(response.videoListCache, 'miss');
    const source = response.data.videos.find(video => video.name === 'qa_source.mp4');
    assert.ok(source);
    assert.ok(Math.abs(source.duration - 6) < 0.2, `duration=${source.duration}`);
    const warmTimes = [];
    let warmAppMs = null;
    for (let i = 0; i < 5; i++) {
      const warmStart = Date.now();
      const warm = await api(`/api/video/list?id=${projectId}`);
      warmTimes.push(Date.now() - warmStart);
      assert.equal(warm.status, 200);
      assert.equal(warm.videoListCache, 'hit');
      assert.equal(warm.data.videos.length, response.data.videos.length);
      warmAppMs = Number(warm.serverTiming?.match(/app;dur=([\d.]+)/)?.[1]);
      assert.ok(Number.isFinite(warmAppMs) && warmAppMs < 10, `warm server processing=${warm.serverTiming}`);
    }
    warmTimes.sort((a, b) => a - b);
    return `${response.data.videos.length} video; duration=${source.duration.toFixed(3)}s; warm median RTT=${warmTimes[2]}ms; server=${warmAppMs.toFixed(2)}ms`;
  });

  const waveRoute = `/api/video/waveform-peaks?projectId=${projectId}&videoName=qa_source.mp4&points=60`;
  await check('Waveform: tạo cache lần đầu', async () => {
    const response = await api(waveRoute);
    assert.equal(response.status, 200);
    assert.equal(response.data.count, 60);
    assert.equal(response.data.cached, false);
    return `${response.data.count} peaks`;
  });
  await check('Waveform: cache hit lần hai', async () => {
    const response = await api(waveRoute);
    assert.equal(response.status, 200);
    assert.equal(response.data.cached, true);
    return `${response.data.count} peaks cached`;
  });

  const cut1 = await (async () => {
    let data;
    await check('Cắt nhanh lossless', async () => {
      data = await postVideo('/api/video/smart-cut', { projectId, videoName: 'qa_source.mp4', start: 1, end: 3, lossless: true });
      assert.ok(data.newDuration >= 1.5 && data.newDuration <= 2.5, `duration=${data.newDuration}`);
      assert.equal(data.lightingLevel, 'none');
      assert.match(data.mode, /Lossless Stream Copy/);
      const list = await api(`/api/video/list?id=${projectId}`);
      assert.equal(list.videoListCache, 'miss', 'tác vụ tạo media phải vô hiệu hóa cache thư viện');
      assert.ok(list.data.videos.some(video => video.name === data.fileName), 'video vừa cắt phải xuất hiện trong thư viện');
      return `${data.newDuration.toFixed(3)}s; ${data.processTimeMs}ms`;
    });
    return data?.fileName;
  })();

  const cut2 = await (async () => {
    let data;
    await check('Cắt nhanh đoạn thứ hai', async () => {
      data = await postVideo('/api/video/smart-cut', { projectId, videoName: 'qa_source.mp4', start: 3, end: 5, lossless: true });
      assert.ok(data.newDuration >= 1.5 && data.newDuration <= 2.5, `duration=${data.newDuration}`);
      return `${data.newDuration.toFixed(3)}s`;
    });
    return data?.fileName;
  })();

  await check('Cắt nâng chất lượng 720p/độ nét', async () => {
    const data = await postVideo('/api/video/smart-cut', {
      projectId, videoName: 'qa_source.mp4', start: 1, end: 3,
      lossless: false, targetRes: '720p', sharpen: true, colorBoost: true
    });
    assert.ok(data.newDuration >= 1.5 && data.newDuration <= 2.5, `duration=${data.newDuration}`);
    return `${data.newDuration.toFixed(3)}s; ${data.processTimeMs}ms; ${data.mode}`;
  });

  await check('Làm sáng video hai mức tự nhiên/sáng rõ', async () => {
    const outputs = [];
    for (const lightingLevel of ['natural', 'bright']) {
      const data = await postVideo('/api/video/smart-cut', {
        projectId, videoName: 'qa_source.mp4', start: 1, end: 3,
        lossless: true, targetRes: 'original', lightingLevel
      });
      assert.equal(data.lightingLevel, lightingLevel);
      assert.match(data.mode, new RegExp(lightingLevel));
      assert.ok(data.newDuration >= 1.5 && data.newDuration <= 2.5, `duration=${data.newDuration}`);
      await fs.access(path.join(projectDir, 'media', data.fileName));
      outputs.push(`${lightingLevel}=${data.processTimeMs}ms`);
    }
    return outputs.join('; ');
  });

  await check('Lọc tạp âm (denoise)', async () => {
    const data = await postVideo('/api/video/denoise', { projectId, videoName: 'qa_source.mp4' });
    return `${data.duration?.toFixed?.(3) || '?'}s; ${data.processTimeMs}ms`;
  });

  await check('Làm sạch âm thanh', async () => {
    const data = await postVideo('/api/video/audio/clean', { projectId, videoName: 'qa_source.mp4', noiseLevel: 'medium', normalize: true });
    return `${data.duration?.toFixed?.(3) || '?'}s; ${data.processTimeMs}ms`;
  });

  await check('Cắt nhiều đoạn', async () => {
    const data = await postVideo('/api/video/multi-cut', { projectId, videoName: 'qa_source.mp4', segments: [{ start: 0, end: 1.5 }, { start: 4, end: 5.5 }] });
    assert.ok(data.newDuration > 2.5 && data.newDuration < 3.5, `duration=${data.newDuration}`);
    return `${data.newDuration.toFixed(3)}s; ${data.processTimeMs}ms`;
  });

  await check('Cắt theo kịch bản', async () => {
    const data = await postVideo('/api/video/text-cut', { projectId, videoName: 'qa_source.mp4', keepSegments: [{ start: 0, end: 2 }, { start: 4, end: 6 }] });
    assert.ok(data.newDuration > 3 && data.newDuration < 5, `duration=${data.newDuration}`);
    return `${data.newDuration.toFixed(3)}s; ${data.processTimeMs}ms`;
  });

  await check('Dập phụ đề lên video', async () => {
    const data = await postVideo('/api/video/subtitles/burn', {
      projectId, videoName: 'qa_source.mp4', karaoke: true, colorScheme: 'capcut_yellow',
      segments: [{ start: 0.5, end: 2, text: 'Kiem tra phu de' }]
    });
    return `${data.duration?.toFixed?.(3) || '?'}s; ${data.processTimeMs}ms`;
  });

  await check('Chèn camera PiP', async () => {
    const data = await postVideo('/api/video/pip', { projectId, mainVideo: 'qa_source.mp4', pipVideo: 'qa_camera.mp4', position: 'bottom-right', pipWidthRatio: 0.28, margin: 24 });
    return `${data.duration?.toFixed?.(3) || '?'}s; ${data.processTimeMs}ms`;
  });

  await check('Ghép video stream-copy', async () => {
    assert.ok(cut1 && cut2, 'hai clip đầu vào chưa được tạo');
    const data = await postVideo('/api/video/concat', { projectId, videoNames: [cut1, cut2], transition: 'cut' });
    return `${data.duration?.toFixed?.(3) || '?'}s; ${data.concatMethod || data.method || 'hoàn tất'}`;
  });

  await check('Ghép video có chuyển cảnh', async () => {
    const data = await postVideo('/api/video/concat', { projectId, videoNames: [cut1, cut2], transition: 'fade' });
    assert.ok(data.duration > 2, `duration=${data.duration}`);
    return `${data.duration.toFixed(3)}s; ${data.concatMethod || data.method || 'render hoàn tất'}`;
  });

  await check('Phát hiện cảnh', async () => {
    const response = await api('/api/video/scene-detect', { projectId, videoName: 'qa_source.mp4', threshold: 0.35, minSceneDur: 2 });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(response.data.ok, true);
    assert.ok(response.data.scenes.length >= 1);
    return `${response.data.scenes.length} cảnh; ${response.data.processMs || response.data.processTimeMs || '?'}ms`;
  });

  await check('Tạo video từ cảnh và dùng cache khi render lại', async () => {
    const project = {
      id: projectId, title: `Codex QA render ${projectId.slice(0, 8)}`,
      ratio: '16:9', resolution: '720p', script_approved: true,
      scenes: [{ id: 'qa-cache-scene', text: 'Kiem tra cache render', duration: 2, generated_video: 'media/qa_source.mp4' }]
    };
    const cold = await api('/api/render', project, 120000);
    assert.equal(cold.status, 200, JSON.stringify(cold.data));
    const warm = await api('/api/render', project, 120000);
    assert.equal(warm.status, 200, JSON.stringify(warm.data));
    assert.equal(warm.data.cacheHits, 1, JSON.stringify(warm.data));
    const mutedProject = {
      ...project,
      scenes: project.scenes.map(scene => ({ ...scene, volume: 0 }))
    };
    const muted = await api('/api/render', mutedProject, 120000);
    assert.equal(muted.status, 200, JSON.stringify(muted.data));
    assert.equal(muted.data.cacheHits, 0, 'volume=0 phải tạo cache riêng, không dùng cache volume mặc định');
    return `cold=${cold.data.totalMs}ms; warm=${warm.data.totalMs}ms; muted cacheHits=${muted.data.cacheHits}`;
  });

  await check('Cắt/khử ồn/chuẩn hóa loudness bài giảng', async () => {
    const workDir = path.join(projectDir, 'qa-audio-work');
    const output = path.join(projectDir, 'qa-audio-lesson.mp4');
    const result = await buildLesson([
      { src: sourcePath, start: 0.5, end: 2.5 },
      { src: sourcePath, start: 3.5, end: 5.5 }
    ], workDir, output);
    assert.equal(result.sync.ok, true, JSON.stringify(result.sync));
    await fs.access(output);
    return `A/V lệch ${(result.sync.diff * 1000).toFixed(1)}ms; cảnh báo=${result.warnings.length}`;
  });

} catch (error) {
  record('Bộ kiểm thử tổng thể', 'ABORTED', error.stack || error.message);
} finally {
  if (projectDir) {
    const projectsRoot = path.resolve(ROOT, 'projects');
    const target = path.resolve(projectDir);
    if (path.dirname(target) === projectsRoot && projectId && /^[a-f0-9-]{36}$/i.test(projectId)) {
      await fs.rm(target, { recursive: true, force: true }).catch(error => record('Dọn project QA tạm', 'FAIL', error.message));
    }
  }
  if (startedServer && !startedServer.killed) startedServer.kill();
  console.log('\n=== KẾT QUẢ FULL QA ===');
  for (const result of results) {
    console.log(`${result.status.padEnd(14)} ${result.name} (${result.ms}ms) — ${result.details}`);
  }
  const failed = results.filter(result => result.status === 'FAIL' || result.status === 'ABORTED');
  const passed = results.filter(result => result.status === 'PASS');
  console.log(`\nPASS ${passed.length} | FAIL ${failed.length} | GAPS/BLOCKED ${results.length - passed.length - failed.length}`);
  if (failed.length) process.exitCode = 1;
}
