/**
 * VIDEO CONCAT PLANNER v3
 *
 * Thay đổi so với v2:
 *  - So fps (số, ngưỡng 0.05) và timeBase giữa các clip, không chỉ profile.
 *  - Phá hòa majority bằng tổng thời lượng.
 *  - Chỉ chuẩn hóa CÁC CLIP LỆCH (giai đoạn 0) rồi concat copy; chỉ render lại toàn bộ
 *    khi có transition / ép render / quá nhiều clip lệch.
 *  - Lọc ảnh bìa nhúng (attached_pic) khỏi luồng video.
 *  - Tách lỗi "ffprobe không chạy được" khỏi "file hỏng".
 *  - Cache có trần kích thước.
 *
 * Quy ước kết quả: mọi strategy đều trả { strategy, reason, warnings[] }.
 *   ABORT                       -> không ghép được (xem reason, badIndexes...)
 *   FAST_STREAM_COPY            -> concat demuxer -c copy
 *   NORMALIZE_CLIPS_THEN_COPY   -> giai đoạn 0: xử lý riêng từng clip trong clipActions,
 *                                  giai đoạn 1: concat demuxer -c copy
 *   FULL_2STAGE_RENDER          -> pipeline 2 giai đoạn hiện có (concat copy rồi re-encode 1 luồng)
 *
 * Lưu ý cho executor giai đoạn 0: khi re-encode clip có rotation, ffmpeg tự xoay hình
 * (autorotate) và bỏ cờ xoay; luôn thêm scale + setsar=1 + fps + format về target.video.
 */

const CACHE_LIMIT = 500;
const signatureCache = new Map(); // `${path}:${mtimeMs}:${size}` -> signature

export const TARGET_AUDIO = Object.freeze({ codec: 'aac', profile: 'LC', sampleRate: 48000, channels: 2 });
export const FPS_TOLERANCE = 0.05;      // 29.97 vs 30 coi là gần bằng nhau
export const OFFSET_SAFE_MS = 60;       // lệch audio/video dưới mức này coi là an toàn

export const parseNum = (x, d = 0) => {
  if (x === null || x === undefined || x === 'N/A') return d;
  const n = parseFloat(x);
  return Number.isFinite(n) ? n : d;
};

export const parseFrac = (s) => {
  if (!s || typeof s !== 'string') return 0;
  const [n, d] = s.split('/').map(Number);
  if (!Number.isFinite(n)) return 0;
  return d ? n / d : n;
};

/** Chuẩn hóa góc về 0/90/180/270 theo chiều kim đồng hồ. */
export const normRotation = (d) => {
  const n = Number(d);
  if (!Number.isFinite(n)) return 0;
  return ((Math.round(n) % 360) + 360) % 360;
};

/**
 * Display Matrix của ffprobe: rotation ngược chiều kim đồng hồ -> đổi dấu.
 * Tag "rotate" (kiểu cũ) là thuận chiều -> giữ nguyên.
 */
export function extractRotation(vStream, format) {
  if (!vStream) return 0;
  if (Array.isArray(vStream.side_data_list)) {
    for (const sd of vStream.side_data_list) {
      if (sd.side_data_type === 'Display Matrix' && sd.rotation !== undefined) {
        return normRotation(-Number(sd.rotation));
      }
    }
  }
  const tagRot = vStream.tags?.rotate ?? format?.tags?.rotate;
  return tagRot !== undefined ? normRotation(tagRot) : 0;
}

const isProbeUnavailable = (err) =>
  err && (err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'EPERM' || /spawn/i.test(String(err.message)));

/**
 * Chữ ký kỹ thuật của một clip. Trả về:
 *   - object chữ ký (có hasVideo/hasAudio/video/audio/duration), hoặc
 *   - { filePath, error: 'PROBE_UNAVAILABLE' | 'UNREADABLE', message }
 */
export async function getVideoSignature(filePath, ffprobeBin, runCommand, fsStatSync) {
  let cacheKey = null;
  if (fsStatSync) {
    try {
      const st = fsStatSync(filePath);
      cacheKey = `${filePath}:${st.mtimeMs}:${st.size}`;
      const hit = signatureCache.get(cacheKey);
      if (hit) return hit;
    } catch { /* không stat được thì bỏ qua cache */ }
  }

  try {
    const { out } = await runCommand(ffprobeBin, [
      '-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath
    ], { timeout: 15000, windowsHide: true });

    const data = JSON.parse(out || '{}');
    const streams = Array.isArray(data.streams) ? data.streams : [];
    // Bỏ ảnh bìa nhúng (MP3/M4A có cover mjpeg/png)
    const v = streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
    const a = streams.find(s => s.codec_type === 'audio');

    const baseStart = parseNum(data.format?.start_time, 0);
    const vStart = parseNum(v?.start_time, baseStart);
    const aStart = a ? parseNum(a.start_time, baseStart) : baseStart;
    const offsetMs = a && v ? Math.round(Math.abs(aStart - vStart) * 1000) : 0;

    const sig = {
      filePath,
      hasVideo: Boolean(v),
      hasAudio: Boolean(a),
      video: v ? {
        codec: v.codec_name || 'unknown',
        profile: v.profile || '',
        level: parseNum(v.level, 0),
        width: Number(v.width) || 0,
        height: Number(v.height) || 0,
        pixFmt: v.pix_fmt || '',
        sar: v.sample_aspect_ratio || '1:1',
        rFrameRate: v.r_frame_rate || '',
        rFps: parseFrac(v.r_frame_rate),
        avgFps: parseFrac(v.avg_frame_rate),
        timeBase: v.time_base || '',
        rotation: extractRotation(v, data.format)
      } : null,
      audio: a ? {
        codec: a.codec_name || 'unknown',
        profile: String(a.profile || '').toUpperCase(),
        sampleRate: parseInt(a.sample_rate, 10) || 0,
        channels: parseInt(a.channels, 10) || 0,
        channelLayout: a.channel_layout || '',
        offsetMs
      } : null,
      duration: parseNum(data.format?.duration, 0)
    };

    if (cacheKey) {
      if (signatureCache.size >= CACHE_LIMIT) signatureCache.delete(signatureCache.keys().next().value);
      signatureCache.set(cacheKey, sig);
    }
    return sig;
  } catch (err) {
    return {
      filePath,
      error: isProbeUnavailable(err) ? 'PROBE_UNAVAILABLE' : 'UNREADABLE',
      message: String(err?.message || err)
    };
  }
}

export function clearSignatureCache() { signatureCache.clear(); }

/** Probe nhiều clip với số luồng song song giới hạn. */
export async function getSignaturesBatch(filePaths, ffprobeBin, runCommand, fsStatSync, concurrency = 4) {
  const results = new Array(filePaths.length);
  let next = 0;
  const worker = async () => {
    while (next < filePaths.length) {
      const i = next++;
      results[i] = await getVideoSignature(filePaths[i], ffprobeBin, runCommand, fsStatSync);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, filePaths.length) }, worker));
  return results;
}

/** KHÓA CỨNG: khác nhau thì không thể copy chung -> phải re-encode clip lệch. */
export const getHardKey = v => `${v.width}x${v.height}|${v.codec}|${v.pixFmt}|${v.sar}|rot:${v.rotation}`;

/**
 * Chọn nhóm đa số. Hòa số lượng thì nhóm có tổng thời lượng lớn hơn thắng;
 * vẫn hòa thì nhóm xuất hiện trước thắng (ổn định).
 */
export function pickMajority(items, keyFn) {
  const groups = new Map();
  items.forEach((it, index) => {
    const key = keyFn(it);
    if (!groups.has(key)) groups.set(key, { key, count: 0, totalDuration: 0, sample: it, indices: [] });
    const g = groups.get(key);
    g.count += 1;
    g.totalDuration += it.duration || 0;
    g.indices.push(index);
  });
  let best = null;
  for (const g of groups.values()) {
    if (!best || g.count > best.count || (g.count === best.count && g.totalDuration > best.totalDuration)) best = g;
  }
  return { best, groupCount: groups.size };
}

const fpsKey = (v) => String(Math.round(v.rFps / FPS_TOLERANCE)); // gom các fps gần nhau

/**
 * @param {Array} signatures  kết quả getSignaturesBatch (theo thứ tự ghép)
 * @param {Object} options
 *   transition        'cut' | 'fade' | ...
 *   forceEncode       ép render toàn bộ
 *   trims             [{ trimStart, trimEnd }] theo index (giây, theo file gốc)
 *   maxNormalizeRatio nếu tỉ lệ clip phải chuẩn hóa video vượt mức này -> render toàn bộ (mặc định 0.5)
 */
export function planConcatWorkflow(signatures, options = {}) {
  const { transition = 'cut', forceEncode = false, trims = [], maxNormalizeRatio = 0.5 } = options;

  if (!Array.isArray(signatures) || signatures.length < 2) {
    return { strategy: 'ABORT', reason: 'Cần ít nhất 2 video để ghép nối.', warnings: [] };
  }

  // ---- 1. Lỗi đầu vào ----
  const errs = signatures.map((s, i) => ({ s, i })).filter(({ s }) => !s || s.error);
  if (errs.length) {
    const allUnavailable = errs.length === signatures.length && errs.every(({ s }) => s?.error === 'PROBE_UNAVAILABLE');
    if (allUnavailable) {
      return {
        strategy: 'ABORT', systemError: true, warnings: [],
        reason: 'Không chạy được ffprobe (thiếu file hoặc bị phần mềm diệt virus chặn). Đây không phải lỗi của clip.'
      };
    }
    return {
      strategy: 'ABORT', badIndexes: errs.map(e => e.i), warnings: [],
      reason: `Có ${errs.length} tệp không đọc được cấu trúc container.`
    };
  }
  const audioOnly = signatures.map((s, i) => (!s.hasVideo ? i : -1)).filter(i => i >= 0);
  if (audioOnly.length) {
    return {
      strategy: 'ABORT', audioOnlyIndexes: audioOnly, warnings: [],
      reason: `Tệp thứ ${audioOnly.map(i => i + 1).join(', ')} chỉ có âm thanh (không có luồng hình để ghép).`
    };
  }

  if (forceEncode || ['fade', 'wipeleft', 'circleopen', 'dissolve'].includes(transition)) {
    return { strategy: 'FULL_2STAGE_RENDER', reason: 'Có hiệu ứng chuyển cảnh hoặc ép render lại toàn bộ.', warnings: [] };
  }

  const warnings = [];
  const vids = signatures.map(s => ({ ...s.video, duration: s.duration }));

  // ---- 2. Chuẩn video đích: đa số theo khóa cứng, rồi đa số fps trong nhóm đó ----
  const hard = pickMajority(vids, getHardKey);
  const hardRef = hard.best.sample;
  const inHardGroup = vids.filter(v => getHardKey(v) === hard.best.key);
  const fpsMajority = pickMajority(inHardGroup, fpsKey).best.sample;
  const profileMajority = pickMajority(inHardGroup, v => v.profile).best.sample.profile;

  const target = {
    video: {
      width: hardRef.width, height: hardRef.height, codec: hardRef.codec, pixFmt: hardRef.pixFmt,
      sar: hardRef.sar, rotation: hardRef.rotation,
      fps: fpsMajority.rFps, rFrameRate: fpsMajority.rFrameRate,
      profile: profileMajority, timeBase: fpsMajority.timeBase
    },
    audio: TARGET_AUDIO
  };

  // ---- 3. Từng clip: lệch video? lệch audio? ----
  const clipActions = [];
  let videoFixCount = 0;
  let timescaleDiffers = false;

  signatures.forEach((sig, idx) => {
    const v = sig.video;
    const trim = trims[idx] || {};
    const tStart = parseNum(trim.trimStart, 0);
    const tEnd = parseNum(trim.trimEnd, sig.duration);
    const effectiveDuration = Math.max(0.1, tEnd - tStart);

    const vReasons = [];
    if (getHardKey(v) !== hard.best.key) {
      vReasons.push(`Khác kích thước/codec/pix_fmt/SAR/xoay (${getHardKey(v)} so với ${hard.best.key})`);
    }
    if (v.profile !== profileMajority && getHardKey(v) === hard.best.key) {
      vReasons.push(`Khác profile H.264 (${v.profile || '?'} so với ${profileMajority || '?'}): nguy cơ SPS/PPS không tương thích`);
    }
    if (v.rFps > 0 && target.video.fps > 0 && Math.abs(v.rFps - target.video.fps) > FPS_TOLERANCE) {
      vReasons.push(`Khác fps (${v.rFps.toFixed(3)} so với ${target.video.fps.toFixed(3)})`);
    }
    if (!vReasons.length) {
      if (v.level !== fpsMajority.level && v.level) warnings.push({ type: 'LEVEL_DIFF', index: idx, message: `Clip ${idx + 1} khác H.264 level; thường vẫn chạy được.` });
      if (v.timeBase && v.timeBase !== target.video.timeBase) timescaleDiffers = true;
      if (v.rFps > 0 && Math.abs(v.rFps - target.video.fps) > 0 && Math.abs(v.rFps - target.video.fps) <= FPS_TOLERANCE) {
        warnings.push({ type: 'FPS_NEAR', index: idx, message: `Clip ${idx + 1} lệch fps rất nhỏ (${v.rFps.toFixed(3)}); đặt -video_track_timescale thống nhất khi concat.` });
      }
    }

    // Audio
    let audioAction = null;
    if (!sig.hasAudio) {
      audioAction = { type: 'INJECT_SILENCE', reason: 'Clip không có tiếng: chèn track câm 48 kHz stereo đúng thời lượng đã tỉa.' };
    } else {
      const a = sig.audio;
      const bad = [];
      if (a.codec !== TARGET_AUDIO.codec) bad.push(`codec ${a.codec}`);
      if (a.codec === 'aac' && a.profile && !a.profile.includes('LC')) bad.push(`profile ${a.profile}`);
      if (a.sampleRate !== TARGET_AUDIO.sampleRate) bad.push(`${a.sampleRate || '?'} Hz`);
      if (a.channels !== TARGET_AUDIO.channels) bad.push(`${a.channels || '?'} kênh`);
      if (a.offsetMs >= OFFSET_SAFE_MS) bad.push(`lệch A/V ${a.offsetMs} ms`);
      if (bad.length) audioAction = { type: 'RESAMPLE_AUDIO', reason: `Audio lệch chuẩn: ${bad.join(', ')}` };
    }
    // Nếu không clip nào có tiếng thì không cần chèn câm
    if (audioAction?.type === 'INJECT_SILENCE' && !signatures.some(s => s.hasAudio)) audioAction = null;

    if (vReasons.length) videoFixCount += 1;
    if (vReasons.length || audioAction) {
      clipActions.push({
        index: idx, filePath: sig.filePath,
        video: vReasons.length ? { type: 'REENCODE_TO_TARGET', reasons: vReasons } : null,
        audio: audioAction,
        trimStart: tStart, trimEnd: tEnd, effectiveDuration
      });
    }
    // Clip copy mà có inpoint không nằm trên keyframe -> điểm cắt thực có thể lệch
    if (!vReasons.length && tStart > 0) {
      warnings.push({ type: 'TRIM_KEYFRAME', index: idx, message: `Clip ${idx + 1} có điểm vào ${tStart}s: với stream copy, điểm cắt thực sẽ snap theo keyframe.` });
    }
  });

  if (timescaleDiffers) warnings.push({ type: 'TIMESCALE', message: 'Time base khác nhau giữa các clip; đặt -video_track_timescale thống nhất khi concat.' });

  // ---- 4. Quyết định ----
  if (videoFixCount / signatures.length > maxNormalizeRatio) {
    return {
      strategy: 'FULL_2STAGE_RENDER', target, warnings,
      reason: `${videoFixCount}/${signatures.length} clip lệch chuẩn video; render lại toàn bộ sẽ rẻ hơn chuẩn hóa từng clip.`
    };
  }
  if (!clipActions.length) {
    return {
      strategy: 'FAST_STREAM_COPY', target, warnings,
      hasAudio: signatures.some(s => s.hasAudio),
      reason: 'Tất cả clip khớp chuẩn video và audio. Ghép bằng concat demuxer -c copy.'
    };
  }
  return {
    strategy: 'NORMALIZE_CLIPS_THEN_COPY', target, clipActions, warnings,
    reason: `Chuẩn hóa riêng ${clipActions.length}/${signatures.length} clip (video: ${videoFixCount}, audio: ${clipActions.filter(c => c.audio).length}) rồi ghép copy.`
  };
}
