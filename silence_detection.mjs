export const DEFAULT_SILENCE_PADDING_SECONDS = 0.35;
export const MIN_SILENCE_CUT_SECONDS = 0.8;

/** Parse FFmpeg silencedetect events and return only safely padded cut proposals. */
export function parseSilenceDetectLog(stderr, totalDuration, {
  paddingSeconds = DEFAULT_SILENCE_PADDING_SECONDS,
  minCutSeconds = MIN_SILENCE_CUT_SECONDS
} = {}) {
  const duration = Math.max(0, Number(totalDuration) || 0);
  const padding = Math.max(0, Number(paddingSeconds) || 0);
  const minCut = Math.max(0, Number(minCutSeconds) || 0);
  if (!duration) return [];

  const spans = [];
  let activeStart = null;
  for (const line of String(stderr || '').split(/\r?\n/)) {
    const startMatch = line.match(/silence_start:\s*(-?\d+(?:\.\d+)?)/i);
    if (startMatch) {
      const start = Number(startMatch[1]);
      if (Number.isFinite(start)) activeStart = Math.max(0, Math.min(duration, start));
    }

    const endMatch = line.match(/silence_end:\s*(-?\d+(?:\.\d+)?)/i);
    if (endMatch && activeStart !== null) {
      const end = Math.max(activeStart, Math.min(duration, Number(endMatch[1])));
      spans.push({ rawStart: activeStart, rawEnd: end });
      activeStart = null;
    }
  }
  if (activeStart !== null) spans.push({ rawStart: activeStart, rawEnd: duration });

  const suggestions = [];
  for (const span of spans) {
    if (!Number.isFinite(span.rawEnd) || span.rawEnd <= span.rawStart) continue;
    const cutStart = Math.min(span.rawEnd, span.rawStart + padding);
    const cutEnd = Math.max(span.rawStart, span.rawEnd - padding);
    const cutDuration = cutEnd - cutStart;
    if (cutDuration + 1e-9 < minCut) continue;
    const index = suggestions.length + 1;
    suggestions.push({
      id: `sil_${index}`,
      rawStart: Number(span.rawStart.toFixed(3)),
      rawEnd: Number(span.rawEnd.toFixed(3)),
      cutStart: Number(cutStart.toFixed(3)),
      cutEnd: Number(cutEnd.toFixed(3)),
      duration: Number(cutDuration.toFixed(3))
    });
  }
  return suggestions;
}
