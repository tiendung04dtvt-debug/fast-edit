import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/** Stream file hashes and reuse them while the file's stat identity is unchanged. */
export function createFileHashReader({ maxEntries = 500, statFile = fs.stat, openStream = createReadStream } = {}) {
  const cache = new Map();
  const inFlight = new Map();

  return {
    async get(filePath, knownStat = null) {
      const stat = knownStat || await statFile(filePath).catch(() => null);
      if (!stat) return '';
      const key = `${path.resolve(filePath)}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      if (cache.has(key)) {
        const value = cache.get(key);
        cache.delete(key);
        cache.set(key, value);
        return value;
      }
      if (inFlight.has(key)) return inFlight.get(key);

      const pending = (async () => {
        try {
          const hash = crypto.createHash('sha256');
          for await (const chunk of openStream(filePath)) hash.update(chunk);
          const value = hash.digest('hex');
          cache.set(key, value);
          while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
          return value;
        } catch { return ''; }
      })().finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
      return pending;
    },
    clear() { cache.clear(); },
    get size() { return cache.size; }
  };
}
