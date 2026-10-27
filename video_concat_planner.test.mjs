import assert from 'node:assert/strict';
import {
  planConcatWorkflow, normRotation, extractRotation, getVideoSignature, clearSignatureCache
} from './video_concat_planner.mjs';

const vid = (o = {}) => ({
  codec: 'h264', profile: 'High', level: 40, width: 1920, height: 1080, pixFmt: 'yuv420p',
  sar: '1:1', rFrameRate: '30/1', rFps: 30, avgFps: 30, timeBase: '1/15360', rotation: 0, ...o
});
const aud = (o = {}) => ({ codec: 'aac', profile: 'LC', sampleRate: 48000, channels: 2, channelLayout: 'stereo', offsetMs: 0, ...o });
const sig = (name, { v = {}, a = {}, noAudio = false, duration = 60 } = {}) => ({
  filePath: name, hasVideo: true, hasAudio: !noAudio, video: vid(v), audio: noAudio ? null : aud(a), duration
});

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('rotation: -90 (display matrix) -> 270, 90 -> 90', () => {
  assert.equal(extractRotation({ side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] }), 90);
  assert.equal(extractRotation({ side_data_list: [{ side_data_type: 'Display Matrix', rotation: 90 }] }), 270);
  assert.equal(extractRotation({ tags: { rotate: '90' } }), 90);
  assert.equal(normRotation(-90), 270);
});

t('tất cả khớp -> FAST_STREAM_COPY', () => {
  const p = planConcatWorkflow([sig('a'), sig('b'), sig('c')]);
  assert.equal(p.strategy, 'FAST_STREAM_COPY');
});

t('clip null / lỗi -> ABORT với badIndexes', () => {
  const p = planConcatWorkflow([sig('a'), { filePath: 'x', error: 'UNREADABLE' }]);
  assert.equal(p.strategy, 'ABORT');
  assert.deepEqual(p.badIndexes, [1]);
});

t('ffprobe không chạy được -> systemError, không đổ lỗi cho clip', () => {
  const e = f => ({ filePath: f, error: 'PROBE_UNAVAILABLE' });
  const p = planConcatWorkflow([e('a'), e('b')]);
  assert.equal(p.strategy, 'ABORT');
  assert.equal(p.systemError, true);
});

t('file chỉ có tiếng -> ABORT audioOnly', () => {
  const p = planConcatWorkflow([sig('a'), { ...sig('b'), hasVideo: false, video: null }]);
  assert.deepEqual(p.audioOnlyIndexes, [1]);
});

t('clip câm + audio 44.1k: chỉ chuẩn hóa audio của clip lệch', () => {
  const p = planConcatWorkflow([sig('a'), sig('b', { noAudio: true }), sig('c', { a: { codec: 'mp3', sampleRate: 44100 } }), sig('d')]);
  assert.equal(p.strategy, 'NORMALIZE_CLIPS_THEN_COPY');
  assert.deepEqual(p.clipActions.map(c => [c.index, c.audio.type, c.video]), [[1, 'INJECT_SILENCE', null], [2, 'RESAMPLE_AUDIO', null]]);
});

t('không clip nào có tiếng -> không chèn câm', () => {
  const p = planConcatWorkflow([sig('a', { noAudio: true }), sig('b', { noAudio: true })]);
  assert.equal(p.strategy, 'FAST_STREAM_COPY');
  assert.equal(p.hasAudio, false);
});

t('khác profile (1 clip) -> chỉ chuẩn hóa clip đó', () => {
  const p = planConcatWorkflow([sig('a'), sig('b'), sig('c', { v: { profile: 'Constrained Baseline' } }), sig('d')]);
  assert.equal(p.strategy, 'NORMALIZE_CLIPS_THEN_COPY');
  assert.equal(p.clipActions.length, 1);
  assert.equal(p.clipActions[0].index, 2);
  assert.match(p.clipActions[0].video.reasons[0], /profile/);
});

t('24 fps lẫn 30 fps -> clip lệch bị gắn cờ', () => {
  const p = planConcatWorkflow([sig('a'), sig('b'), sig('c', { v: { rFps: 24, rFrameRate: '24/1' } }), sig('d')]);
  assert.equal(p.clipActions[0].index, 2);
  assert.match(p.clipActions[0].video.reasons.join(), /fps/);
});

t('29.97 vs 30 -> vẫn copy, kèm cảnh báo FPS_NEAR', () => {
  const p = planConcatWorkflow([sig('a'), sig('b'), sig('c', { v: { rFps: 30000 / 1001, rFrameRate: '30000/1001' } })]);
  assert.equal(p.strategy, 'FAST_STREAM_COPY');
  assert.ok(p.warnings.some(w => w.type === 'FPS_NEAR'));
});

t('xoay 90 vs 270 là hai nhóm khác nhau', () => {
  const p = planConcatWorkflow([sig('a', { v: { rotation: 90 } }), sig('b', { v: { rotation: 90 } }), sig('c', { v: { rotation: 270 } })]);
  assert.equal(p.clipActions.length, 1);
  assert.equal(p.clipActions[0].index, 2);
});

t('hòa 2-2: nhóm có tổng thời lượng lớn hơn làm chuẩn', () => {
  const p = planConcatWorkflow([
    sig('a', { v: { width: 1280, height: 720 }, duration: 10 }), sig('b', { v: { width: 1280, height: 720 }, duration: 10 }),
    sig('c', { duration: 600 }), sig('d', { duration: 600 })
  ], { maxNormalizeRatio: 0.9 });
  assert.equal(p.target.video.width, 1920);
});

t('quá nửa clip lệch video -> FULL_2STAGE_RENDER', () => {
  const p = planConcatWorkflow([sig('a'), sig('b', { v: { profile: 'Main' } }), sig('c', { v: { profile: 'Baseline' } })]);
  assert.equal(p.strategy, 'FULL_2STAGE_RENDER');
});

t('transition / forceEncode -> FULL_2STAGE_RENDER', () => {
  assert.equal(planConcatWorkflow([sig('a'), sig('b')], { transition: 'fade' }).strategy, 'FULL_2STAGE_RENDER');
  assert.equal(planConcatWorkflow([sig('a'), sig('b')], { forceEncode: true }).strategy, 'FULL_2STAGE_RENDER');
});

t('thời lượng hiệu dụng tính theo đoạn đã tỉa', () => {
  const p = planConcatWorkflow([sig('a'), sig('b', { noAudio: true, duration: 100 })], { trims: [{}, { trimStart: 10, trimEnd: 40 }] });
  assert.equal(p.clipActions[0].effectiveDuration, 30);
});

// --- getVideoSignature với ffprobe giả ---
const fakeRun = (json) => async () => ({ out: JSON.stringify(json) });

const asyncTests = async () => {
  clearSignatureCache();
  // MP3 có ảnh bìa: không được tính là video
  const mp3 = await getVideoSignature('x.mp3', 'ffprobe', fakeRun({
    streams: [
      { codec_type: 'audio', codec_name: 'mp3', sample_rate: '44100', channels: 2 },
      { codec_type: 'video', codec_name: 'mjpeg', width: 500, height: 500, disposition: { attached_pic: 1 } }
    ],
    format: { duration: '200.0', start_time: 'N/A' }
  }));
  assert.equal(mp3.hasVideo, false); n++; console.log('ok - ảnh bìa nhúng không phải luồng video');

  // start_time N/A không sinh offset giả
  const ts = await getVideoSignature('y.ts', 'ffprobe', fakeRun({
    streams: [
      { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, r_frame_rate: '30/1', start_time: 'N/A' },
      { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2, start_time: 'N/A' }
    ],
    format: { duration: '10', start_time: '1.4' }
  }));
  assert.equal(ts.audio.offsetMs, 0); n++; console.log('ok - start_time N/A dùng fallback đối xứng');

  // ffprobe thiếu -> PROBE_UNAVAILABLE
  const missing = await getVideoSignature('z.mp4', 'ffprobe', async () => { const e = new Error('spawn ffprobe ENOENT'); e.code = 'ENOENT'; throw e; });
  assert.equal(missing.error, 'PROBE_UNAVAILABLE'); n++; console.log('ok - ffprobe thiếu được tách khỏi file hỏng');

  // JSON hỏng -> UNREADABLE
  const broken = await getVideoSignature('w.mp4', 'ffprobe', async () => ({ out: 'not json' }));
  assert.equal(broken.error, 'UNREADABLE'); n++; console.log('ok - JSON lỗi -> UNREADABLE');

  // sample_rate thiếu -> 0 (bị gắn cờ, không ngầm coi là 48k)
  const noRate = await getVideoSignature('q.mp4', 'ffprobe', fakeRun({
    streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 }, { codec_type: 'audio', codec_name: 'aac' }],
    format: { duration: '5' }
  }));
  assert.equal(noRate.audio.sampleRate, 0); n++; console.log('ok - sample_rate thiếu mặc định 0');
};

await asyncTests();
console.log(`\n${n} test đạt.`);
