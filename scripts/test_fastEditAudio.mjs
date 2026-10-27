import { buildLesson } from '../fastEditAudio.mjs';
import path from 'node:path';
import fs from 'node:fs';

const workDir = 'D:\\VuonBaiGiang\\temp_audio_test';
if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
fs.mkdirSync(workDir, { recursive: true });

const srcVideo = 'D:\\VuonBaiGiang\\projects\\6a6021d9-9563-4e7e-a25f-c9b9bfce22c7\\media\\cut_1793045207768_merged_1793044161780_capcut.mp4';
const finalOut = path.join(workDir, 'output_lesson.mp4');

console.log('Testing buildLesson with 2 clips from real source video...');
const t0 = Date.now();

try {
  const result = await buildLesson([
    { src: srcVideo, start: 2.0, end: 8.0 },
    { src: srcVideo, start: 12.0, end: 18.0 }
  ], workDir, finalOut);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`✓ buildLesson SUCCESS in ${elapsed}s!`);
  console.log('Sync Check:', result.sync);
  console.log('Loudnorm Measured:', result.measured);
  console.log('Loudnorm Out:', result.loudnormOut);
  console.log('Warnings:', result.warnings);
} catch (err) {
  console.error('buildLesson FAILED:', err);
} finally {
  if (fs.existsSync(workDir)) {
    fs.rmSync(workDir, { recursive: true, force: true });
    console.log('Cleaned up test workDir.');
  }
}
