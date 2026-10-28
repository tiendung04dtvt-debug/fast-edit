import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileHashReader } from './file_hash.mjs';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fast-edit-hash-'));
try {
  const filePath = path.join(tempDir, 'large-media.bin');
  const firstContent = Buffer.alloc(4 * 1024 * 1024, 0xA5);
  await fs.writeFile(filePath, firstContent);

  let streamCount = 0;
  const reader = createFileHashReader({
    openStream: file => { streamCount++; return createReadStream(file); }
  });
  const expectedFirst = crypto.createHash('sha256').update(firstContent).digest('hex');
  const [first, concurrent] = await Promise.all([reader.get(filePath), reader.get(filePath)]);
  assert.equal(first, expectedFirst);
  assert.equal(concurrent, expectedFirst);
  assert.equal(streamCount, 1, 'concurrent hashing streams the file once');
  assert.equal(await reader.get(filePath), expectedFirst);
  assert.equal(streamCount, 1, 'unchanged files use the hash cache');

  const secondContent = Buffer.alloc(firstContent.length + 1, 0x3C);
  await fs.writeFile(filePath, secondContent);
  const expectedSecond = crypto.createHash('sha256').update(secondContent).digest('hex');
  assert.equal(await reader.get(filePath), expectedSecond);
  assert.equal(streamCount, 2, 'a changed file is hashed again');
  reader.clear();
  console.log('file hash tests: 4 passed');
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
