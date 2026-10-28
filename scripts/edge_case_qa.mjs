import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFreeDiskSpace } from '../fastEditAudio.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT || 4195);
const BASE = `http://127.0.0.1:${PORT}`;
const NODE = process.execPath;
const FFMPEG = path.join(ROOT, 'runtime', 'ffmpeg.exe');
const MONITOR_PS = path.join(ROOT, 'scripts', 'measure_process_tree.ps1');
const results = [];
let projectId = null;
let projectDir = null;
let startedServer = null;
let monitorDir = null;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function api(route, body, { signal, timeoutMs = 180000 } = {}) {
  const response = await fetch(`${BASE}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal || AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
  return { status: response.status, data };
}

async function waitForQaServer() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const response = await api('/api/qa/resources', undefined, { timeoutMs: 1200 });
      if (response.status === 200 && response.data.pid) return response.data;
    } catch {}
    await delay(150);
  }
  throw new Error(`QA server/metrics endpoint không sẵn sàng ở ${BASE}`);
}

async function ensureServer() {
  try {
    const response = await api('/api/qa/resources', undefined, { timeoutMs: 500 });
    if (response.status === 200 && response.data.pid) return response.data;
    throw new Error(`Port ${PORT} đang được dùng bởi server không bật QA metrics.`);
  } catch (error) {
    if (/đang được dùng/.test(error.message)) throw error;
  }
  startedServer = spawn(NODE, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), FASTEDIT_QA_METRICS: '1' },
    windowsHide: true,
    stdio: 'ignore'
  });
  return waitForQaServer();
}

function runProcess(bin, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`${path.basename(bin)} vượt timeout ${timeoutMs}ms`));
    }, timeoutMs);
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`${path.basename(bin)} exit ${code}: ${stderr}`));
    });
  });
}

async function check(name, fn) {
  const started = Date.now();
  try {
    const details = await fn();
    results.push({ name, status: 'PASS', ms: Date.now() - started, details: String(details || 'OK') });
  } catch (error) {
    results.push({ name, status: 'FAIL', ms: Date.now() - started, details: error.stack || error.message });
  }
}

async function startResourceMonitor(serverPid) {
  monitorDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fast-edit-resource-'));
  const pidFile = path.join(monitorDir, 'pids.json');
  const stopFile = path.join(monitorDir, 'stop');
  const outputFile = path.join(monitorDir, 'metrics.json');
  await fs.writeFile(pidFile, JSON.stringify({ ffmpegPids: [] }));
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', MONITOR_PS,
    String(serverPid), pidFile, stopFile, outputFile], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`PowerShell monitor exit ${code}: ${stderr}`)));
  });

  return {
    async sample() {
      const metrics = await api('/api/qa/resources', undefined, { timeoutMs: 3000 });
      assert.equal(metrics.status, 200, JSON.stringify(metrics.data));
      await fs.writeFile(pidFile, JSON.stringify({ ffmpegPids: metrics.data.ffmpegPids || [] }));
      return metrics.data;
    },
    async stop() {
      await fs.writeFile(stopFile, 'stop');
      await Promise.race([closed, delay(10000).then(() => { throw new Error('PowerShell monitor chưa dừng'); })]);
      const raw = await fs.readFile(outputFile, 'utf8');
      const firstJson = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
      const metrics = JSON.parse(firstJson);
      await fs.rm(monitorDir, { recursive: true, force: true });
      monitorDir = null;
      return metrics;
    },
    async abort() {
      await fs.writeFile(stopFile, 'stop').catch(() => {});
      await Promise.race([closed.catch(() => {}), delay(3000)]);
      if (monitorDir) await fs.rm(monitorDir, { recursive: true, force: true }).catch(() => {});
      monitorDir = null;
    }
  };
}

async function measuredApi(route, body) {
  const reset = await api('/api/qa/resources?reset=1');
  assert.equal(reset.status, 200, JSON.stringify(reset.data));
  const monitor = await startResourceMonitor(reset.data.pid);
  let done = false;
  const started = Date.now();
  const pending = api(route, body, { timeoutMs: 180000 }).finally(() => { done = true; });
  try {
    while (!done) {
      await monitor.sample();
      await delay(50);
    }
    const response = await pending;
    const serverMetrics = await monitor.sample();
    const processTree = await monitor.stop();
    return { response, wallMs: Date.now() - started, serverMetrics, processTree };
  } catch (error) {
    await monitor.abort();
    throw error;
  }
}

try {
  const serverMetrics = await ensureServer();
  const created = await api('/api/projects', { title: 'Codex Unicode & 4K QA tạm' });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  projectId = created.data.id;
  assert.match(projectId, /^[a-f0-9-]{36}$/i);
  projectDir = path.join(ROOT, 'projects', projectId);
  const mediaDir = path.join(projectDir, 'media');
  await fs.mkdir(mediaDir, { recursive: true });

  const sourcePath = path.join(mediaDir, 'qa_4k_source.mp4');
  await runProcess(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=3840x2160:rate=24:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-g', '24', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-shortest', sourcePath
  ], 180000);

  const unicodeStem = "Bài giảng 'Toán' #1% & [A] 🌸 🎬";
  const nfcName = `${unicodeStem.normalize('NFC')}.mp4`;
  const nfdName = `${unicodeStem.normalize('NFD')}.mp4`;
  assert.notEqual(nfcName, nfdName, 'NFC/NFD fixture names phải khác chuỗi');
  await fs.copyFile(sourcePath, path.join(mediaDir, nfcName));
  await fs.copyFile(sourcePath, path.join(mediaDir, nfdName));
  const diskNames = await fs.readdir(mediaDir);
  assert.ok(diskNames.includes(nfcName) && diskNames.includes(nfdName), 'filesystem phải giữ riêng tên NFC và NFD');

  await check('Unicode NFC/NFD: thư viện, waveform cache và tải file', async () => {
    const list = await api(`/api/video/list?id=${projectId}`);
    assert.equal(list.status, 200, JSON.stringify(list.data));
    const names = list.data.videos.map(video => video.name);
    assert.ok(names.includes(nfcName), `thiếu NFC: ${nfcName}`);
    assert.ok(names.includes(nfdName), `thiếu NFD: ${nfdName}`);

    const waveRoute = `/api/video/waveform-peaks?projectId=${encodeURIComponent(projectId)}&videoName=${encodeURIComponent(nfdName)}&points=60`;
    const wave = await api(waveRoute);
    assert.equal(wave.status, 200, JSON.stringify(wave.data));
    assert.equal(wave.data.peaks.length, 60);
    await fs.access(path.join(mediaDir, `${nfdName}.peaks`));
    const waveWarm = await api(waveRoute);
    assert.equal(waveWarm.data.cached, true);

    const downloaded = await fetch(`${BASE}/projects/${projectId}/media/${encodeURIComponent(nfdName)}`);
    assert.equal(downloaded.status, 200, 'URL tải video có Unicode phải hoạt động');
    const downloadedBytes = Buffer.from(await downloaded.arrayBuffer());
    assert.equal(downloadedBytes.length, (await fs.stat(path.join(mediaDir, nfdName))).size);
    return `NFC/NFD phân biệt; peaks=60; file tải ${downloadedBytes.length} bytes`;
  });

  await check('Unicode: cắt file NFD và tải kết quả', async () => {
    const cut = await api('/api/video/smart-cut', {
      projectId, videoName: nfdName, start: 0, end: 2, lossless: true
    });
    assert.equal(cut.status, 200, JSON.stringify(cut.data));
    const outputName = cut.data.fileName;
    const outputUrl = `${BASE}/projects/${projectId}/media/${encodeURIComponent(outputName)}`;
    const downloaded = await fetch(outputUrl);
    assert.equal(downloaded.status, 200, `không tải được output: ${outputUrl}`);
    assert.ok((await downloaded.arrayBuffer()).byteLength > 2000);
    return `${cut.data.newDuration.toFixed(3)}s; ${cut.data.processTimeMs}ms; kết quả tải được`;
  });

  await check('Unicode: concat demuxer escape apostrophe và ký tự đặc biệt', async () => {
    const concat = await api('/api/video/concat', {
      projectId, videoNames: [nfcName, nfdName], transition: 'cut'
    }, { timeoutMs: 180000 });
    assert.equal(concat.status, 200, JSON.stringify(concat.data));
    assert.ok(concat.data.duration > 6, `duration=${concat.data.duration}`);
    await fs.access(path.join(mediaDir, concat.data.fileName));
    return `${concat.data.duration.toFixed(3)}s; ${concat.data.concatMethod || concat.data.method || 'concat OK'}`;
  });

  await check('4K render + peak RSS/CPU tiến trình thực tế', async () => {
    const renderProject = {
      id: projectId,
      title: unicodeStem,
      ratio: '16:9',
      resolution: '720p',
      script_approved: true,
      scenes: [{ id: 'qa_4k_scene', text: 'Kiểm tra video 4K', duration: 2, generated_video: 'media/qa_4k_source.mp4' }]
    };
    const measured = await measuredApi('/api/render', renderProject);
    assert.equal(measured.response.status, 200, JSON.stringify(measured.response.data));
    const outputName = measured.response.data.output;
    assert.match(outputName, /Bài giảng/);
    const outputPath = path.join(projectDir, outputName);
    const outStat = await fs.stat(outputPath);
    assert.ok(outStat.size > 2000);
    const downloaded = await fetch(`${BASE}/projects/${projectId}/${encodeURIComponent(outputName)}`);
    assert.equal(downloaded.status, 200, 'file master có tên Unicode phải tải được');
    await downloaded.body?.cancel();

    const nodeRssMb = measured.serverMetrics.peakRssBytes / (1024 * 1024);
    const nodeDeltaMb = measured.serverMetrics.peakRssDeltaBytes / (1024 * 1024);
    const treeRssMb = measured.processTree.peakCombinedWorkingSetBytes / (1024 * 1024);
    assert.ok(measured.processTree.samples > 0, 'Windows resource monitor phải lấy được mẫu');
    return `wall=${measured.wallMs}ms; output=${(outStat.size / 1024 / 1024).toFixed(2)}MB; Node peak RSS=${nodeRssMb.toFixed(1)}MB (+${nodeDeltaMb.toFixed(1)}MB); process-tree peak WS=${treeRssMb.toFixed(1)}MB; CPU=${measured.processTree.sampledCpuMs.toFixed(0)}ms (${measured.processTree.sampledCpuPercent.toFixed(1)}% avg; ${measured.processTree.samples} samples)`;
  });

  await check('Hủy render lúc .part đang được ghi và dọn file tạm', async () => {
    const seedProject = {
      id: projectId,
      title: 'qa_cancel_seed',
      ratio: '16:9',
      resolution: '720p',
      script_approved: true,
      scenes: [{ id: 'qa_cancel_scene', text: 'seed', duration: 2, generated_video: 'media/qa_4k_source.mp4' }]
    };
    const seed = await api('/api/render', seedProject, { timeoutMs: 180000 });
    assert.equal(seed.status, 200, JSON.stringify(seed.data));

    const repeatedScenes = Array.from({ length: 500 }, () => ({ ...seedProject.scenes[0] }));
    const cancelProject = { ...seedProject, title: 'qa_cancel_probe', scenes: repeatedScenes };
    const controller = new AbortController();
    const started = Date.now();
    const pending = fetch(`${BASE}/api/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cancelProject),
      signal: controller.signal
    }).catch(() => null);

    const partPrefix = 'qa_cancel_probe.part_';
    let partAppeared = false;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const files = await fs.readdir(projectDir);
      if (files.some(name => name.startsWith(partPrefix))) { partAppeared = true; break; }
      const maybeDone = await api('/api/qa/resources');
      if (!maybeDone.data.ffmpegPids?.length && files.includes('qa_cancel_probe.mp4')) break;
      await delay(10);
    }
    assert.ok(partAppeared, 'render phải đi vào giai đoạn ghi .part trước khi hủy');
    const abortAt = Date.now();
    controller.abort();
    await pending;

    let activePids = [];
    const cleanupDeadline = Date.now() + 10000;
    while (Date.now() < cleanupDeadline) {
      const metrics = await api('/api/qa/resources');
      activePids = metrics.data.ffmpegPids || [];
      const files = await fs.readdir(projectDir);
      if (activePids.length === 0 && !files.some(name => name.startsWith(partPrefix))) break;
      await delay(50);
    }
    const remaining = (await fs.readdir(projectDir)).filter(name => name.startsWith(partPrefix));
    assert.deepEqual(activePids, [], `ffmpeg còn chạy sau hủy: ${activePids.join(',')}`);
    assert.deepEqual(remaining, [], 'file .part phải được dọn sau khi hủy');
    assert.equal(await fs.stat(path.join(projectDir, 'qa_cancel_probe.mp4')).then(() => true, () => false), false,
      'không được tạo master output chưa hoàn tất');
    return `đã thấy .part; hủy và dừng ffmpeg trong ${Date.now() - abortAt}ms; .part còn lại=0`;
  });

  await check('Phòng vệ khi ổ đĩa dưới ngưỡng trống', async () => {
    assert.throws(() => checkFreeDiskSpace(projectDir, Number.MAX_SAFE_INTEGER), /ổ đĩa còn quá ít dung lượng trống/i);
    return 'ngưỡng giả lập cực đại bị từ chối an toàn; không ghi hoặc làm đầy ổ đĩa';
  });
} catch (error) {
  results.push({ name: 'Edge QA setup', status: 'ABORTED', ms: 0, details: error.stack || error.message });
} finally {
  if (projectDir && projectId && /^[a-f0-9-]{36}$/i.test(projectId)) {
    const projectsRoot = path.resolve(ROOT, 'projects');
    const target = path.resolve(projectDir);
    const protectedId = '6a6021d9-9563-4e7e-a25f-c9b9bfce22c7';
    if (path.dirname(target) === projectsRoot && projectId !== protectedId) {
      await fs.rm(target, { recursive: true, force: true }).catch(error => {
        results.push({ name: 'Dọn project edge QA', status: 'FAIL', ms: 0, details: error.message });
      });
    }
  }
  if (monitorDir) await fs.rm(monitorDir, { recursive: true, force: true }).catch(() => {});
  if (startedServer && !startedServer.killed) startedServer.kill();
  console.log('\n=== KẾT QUẢ EDGE QA ===');
  for (const result of results) console.log(`${result.status.padEnd(8)} ${result.name} (${result.ms}ms) — ${result.details}`);
  const failed = results.filter(result => result.status === 'FAIL' || result.status === 'ABORTED');
  const passed = results.filter(result => result.status === 'PASS');
  console.log(`\nPASS ${passed.length} | FAIL ${failed.length} | ABORTED ${results.filter(r => r.status === 'ABORTED').length}`);
  if (failed.length) process.exitCode = 1;
}
