import fs from 'node:fs';
import path from 'node:path';

const dest = 'D:\\VuonBaiGiang\\public\\vendor\\mediapipe';
if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

const files = [
  'selfie_segmentation.js',
  'selfie_segmentation.tflite',
  'selfie_segmentation_landscape.tflite',
  'selfie_segmentation_solution_simd_wasm_bin.js',
  'selfie_segmentation_solution_simd_wasm_bin.wasm',
  'selfie_segmentation_solution_wasm_bin.js',
  'selfie_segmentation_solution_wasm_bin.wasm'
];

for (const f of files) {
  const outPath = path.join(dest, f);
  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
    console.log(`Already exists: ${f}`);
    continue;
  }
  const url = `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation@0.1.1675465747/${f}`;
  console.log(`Downloading ${f}...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${f}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, buf);
  console.log(`Saved ${f} (${(buf.length / 1024).toFixed(1)} KB)`);
}

console.log('All MediaPipe offline assets are ready!');
