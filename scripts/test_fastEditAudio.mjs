import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLesson } from '../fastEditAudio.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FFMPEG = path.join(ROOT, 'runtime', 'ffmpeg.exe');
const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fast-edit-audio-qa-'));
const source = path.join(testDir, 'synthetic-source.mp4');
const output = path.join(testDir, 'output-lesson.mp4');

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${stderr}`)));
  });
}

try {
  await runFfmpeg([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=0x244477:s=320x180:r=24:d=20',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=20',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-g', '48', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-shortest', source
  ]);

  const t0 = Date.now();
  const result = await buildLesson([
    { src: source, start: 2, end: 8 },
    { src: source, start: 12, end: 18 }
  ], testDir, output);
  assert.equal(result.sync.ok, true, `A/V sync failed: ${JSON.stringify(result.sync)}`);
  await fs.access(output);
  console.log(`PASS buildLesson (${((Date.now() - t0) / 1000).toFixed(2)}s)`);
  console.log('A/V sync:', result.sync);
  console.log('Loudnorm measured:', result.measured);
  console.log('Loudnorm output:', result.loudnormOut);
  console.log('Warnings:', result.warnings);
} catch (err) {
  console.error('FAIL buildLesson:', err);
  process.exitCode = 1;
} finally {
  await fs.rm(testDir, { recursive: true, force: true }).catch(err => {
    console.error(`Could not remove isolated QA directory ${testDir}: ${err.message}`);
    process.exitCode = 1;
  });
}
