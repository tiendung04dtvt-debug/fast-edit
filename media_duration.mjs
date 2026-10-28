import fs from 'node:fs/promises';
import path from 'node:path';

/** Cache media duration probes by file identity and coalesce concurrent reads. */
export function createMediaDurationReader({ probe, maxEntries = 500, statFile = fs.stat }) {
  if (typeof probe !== 'function') throw new TypeError('probe must be a function');
  const cache = new Map();
  const inFlight = new Map();

  return {
    async get(filePath, knownStat = null) {
      const stat = knownStat || await statFile(filePath).catch(() => null);
      if (!stat) return null;
      const key = `${path.resolve(filePath)}:${stat.size}:${stat.mtimeMs}`;
      if (cache.has(key)) {
        const value = cache.get(key);
        cache.delete(key);
        cache.set(key, value);
        return value;
      }
      if (inFlight.has(key)) return inFlight.get(key);

      const pending = Promise.resolve().then(() => probe(filePath)).then(value => {
        cache.set(key, value);
        while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
        return value;
      }).finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
      return pending;
    },
    clear() { cache.clear(); },
    get size() { return cache.size; }
  };
}
