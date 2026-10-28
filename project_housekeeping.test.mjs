import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cleanupProjectArtifacts } from './project_housekeeping.mjs';

test('startup cleanup removes only stale temporary/invalid cache files and skips protected projects', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fast-edit-housekeeping-'));
  const projects = path.join(tempRoot, 'projects');
  const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
  const writeOld = async (filePath, content = 'x') => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
    await fs.utimes(filePath, oldTime, oldTime);
  };
  const stalePart = path.join(projects, 'ordinary', 'lesson.part_123.mp4');
  const dotTemp = path.join(projects, 'ordinary', '.tmp_render');
  const cacheTemp = path.join(projects, 'ordinary', 'cache', 'tmp_12345678-1234-1234-1234-123456789abc.mp4');
  const invalidScene = path.join(projects, 'ordinary', 'cache', 'scene_bad.mp4');
  const invalidPeaks = path.join(projects, 'ordinary', 'media', 'bad.mp4.peaks');
  const freshPart = path.join(projects, 'ordinary', 'fresh.part_123.mp4');
  const validPeaks = path.join(projects, 'ordinary', 'media', 'good.mp4.peaks');
  const protectedPart = path.join(projects, '6a6021d9-9563-4e7e-a25f-c9b9bfce22c7', 'media', 'important.part_123.mp4');

  try {
    for (const file of [stalePart, dotTemp, cacheTemp, invalidScene, invalidPeaks, protectedPart]) {
      await writeOld(file, file === validPeaks ? JSON.stringify(Array(60).fill(0.5)) : 'bad');
    }
    await fs.mkdir(path.dirname(validPeaks), { recursive: true });
    await fs.writeFile(validPeaks, JSON.stringify(Array(60).fill(0.5)));
    await fs.writeFile(freshPart, 'new');

    const result = await cleanupProjectArtifacts(projects, {
      excludeProjectIds: ['6a6021d9-9563-4e7e-a25f-c9b9bfce22c7']
    });
    assert.equal(result.removedCount, 5);
    for (const file of [stalePart, dotTemp, cacheTemp, invalidScene, invalidPeaks]) {
      await assert.rejects(fs.access(file));
    }
    for (const file of [freshPart, validPeaks, protectedPart]) await fs.access(file);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
