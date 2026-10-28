import fs from 'node:fs/promises';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;
const isInside = (root, target) => target === root || target.startsWith(root + path.sep);

async function isInvalidCacheFile(filePath, entry, relativePath) {
  const pathParts = relativePath.split(path.sep);
  const inCache = pathParts.includes('cache');
  const inMedia = pathParts.includes('media');
  if (entry.name.endsWith('.peaks') && (inCache || inMedia)) {
    try {
      const peaks = JSON.parse(await fs.readFile(filePath, 'utf8'));
      return !Array.isArray(peaks) || peaks.length < 60 || peaks.length > 360 ||
        peaks.some(value => !Number.isFinite(value) || value < 0 || value > 1);
    } catch {
      return true;
    }
  }
  if (!inCache) return false;
  if (entry.name.startsWith('scene_') && path.extname(entry.name).toLowerCase() === '.mp4') {
    return (await fs.stat(filePath)).size < 2000;
  }
  return false;
}

/** Remove only old, recognizable temporary files and invalid generated cache entries. */
export async function cleanupProjectArtifacts(projectsRoot, {
  excludeProjectIds = [],
  maxAgeMs = DAY_MS,
  now = Date.now()
} = {}) {
  const root = path.resolve(projectsRoot);
  const excluded = new Set(excludeProjectIds);
  const projects = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const queue = [];
  for (const entry of projects) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || excluded.has(entry.name)) continue;
    queue.push(path.join(root, entry.name));
  }

  let removedCount = 0;
  let scannedFiles = 0;
  while (queue.length) {
    const directory = queue.pop();
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const filePath = path.resolve(directory, entry.name);
      if (!isInside(root, filePath) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        queue.push(filePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = path.relative(root, filePath);
      const pathParts = relativePath.split(path.sep);
      const inCache = pathParts.includes('cache');
      const inMedia = pathParts.includes('media');
      const candidate = entry.name.includes('.part_') || entry.name.startsWith('.tmp_') ||
        (inCache && /^tmp_[\w-]+\.mp4$/i.test(entry.name)) ||
        ((inCache || inMedia) && entry.name.endsWith('.peaks')) ||
        (inCache && entry.name.startsWith('scene_') && path.extname(entry.name).toLowerCase() === '.mp4');
      if (!candidate) continue;
      scannedFiles++;
      try {
        const stat = await fs.stat(filePath);
        if (now - stat.mtimeMs < maxAgeMs) continue;
        const stalePart = entry.name.includes('.part_');
        const staleNamedTemp = entry.name.startsWith('.tmp_');
        const staleCacheTemp = relativePath.split(path.sep).includes('cache') &&
          /^tmp_[\w-]+\.mp4$/i.test(entry.name);
        const invalidCache = await isInvalidCacheFile(filePath, entry, relativePath);
        if (stalePart || staleNamedTemp || staleCacheTemp || invalidCache) {
          await fs.unlink(filePath);
          removedCount++;
        }
      } catch {}
    }
  }
  return { removedCount, scannedFiles };
}
