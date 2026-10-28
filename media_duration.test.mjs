import assert from 'node:assert/strict';
import { createMediaDurationReader } from './media_duration.mjs';

const stats = new Map([
  ['a', { size: 10, mtimeMs: 1 }],
  ['b', { size: 20, mtimeMs: 1 }],
  ['c', { size: 30, mtimeMs: 1 }]
]);
let probes = 0;
const reader = createMediaDurationReader({
  maxEntries: 2,
  statFile: async filePath => stats.get(filePath),
  probe: async filePath => {
    probes++;
    await new Promise(resolve => setTimeout(resolve, 5));
    return filePath.length * 10;
  }
});

const [first, concurrent] = await Promise.all([reader.get('a'), reader.get('a')]);
assert.equal(first, 10);
assert.equal(concurrent, 10);
assert.equal(probes, 1, 'concurrent requests for one file share a probe');

assert.equal(await reader.get('a'), 10);
assert.equal(probes, 1, 'a repeated request uses the cache');

stats.set('a', { size: 11, mtimeMs: 2 });
assert.equal(await reader.get('a'), 10);
assert.equal(probes, 2, 'a changed file gets a new probe');

await reader.get('b');
await reader.get('c');
assert.equal(reader.size, 2, 'the cache remains bounded');
await reader.get('a');
assert.equal(probes, 5, 'the least recently used entry is evicted');

reader.clear();
assert.equal(reader.size, 0, 'the cache can be cleared');
console.log('duration cache tests: 5 passed');
