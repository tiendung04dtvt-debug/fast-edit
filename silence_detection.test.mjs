import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSilenceDetectLog } from './silence_detection.mjs';

test('padding 0.35s is applied on both edges and reports the removable duration', () => {
  const proposals = parseSilenceDetectLog([
    '[silencedetect] silence_start: 12.400',
    '[silencedetect] silence_end: 16.200 | silence_duration: 3.800'
  ].join('\n'), 20);
  assert.deepEqual(proposals, [{
    id: 'sil_1', rawStart: 12.4, rawEnd: 16.2,
    cutStart: 12.75, cutEnd: 15.85, duration: 3.1
  }]);
});

test('drops a proposal when the padded cut span is under 0.8s', () => {
  const proposals = parseSilenceDetectLog([
    'silence_start: 1.0',
    'silence_end: 2.4 | silence_duration: 1.4'
  ].join('\n'), 5);
  assert.deepEqual(proposals, []);
});

test('keeps a trailing silence bounded by media duration', () => {
  const proposals = parseSilenceDetectLog('silence_start: 3.0', 5.1);
  assert.deepEqual(proposals, [{
    id: 'sil_1', rawStart: 3, rawEnd: 5.1,
    cutStart: 3.35, cutEnd: 4.75, duration: 1.4
  }]);
});

test('ignores malformed, reversed, and out-of-range events safely', () => {
  const proposals = parseSilenceDetectLog([
    'silence_start: nope',
    'silence_end: 4.0 | silence_duration: 1.0',
    'silence_start: 8.0',
    'silence_end: 9.0 | silence_duration: 1.0'
  ].join('\n'), 5);
  assert.deepEqual(proposals, []);
});
