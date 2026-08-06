export type SubtitleSourceSegment = {
  id: string;
  start_ms: number;
  end_ms: number;
  text: string;
};

export type SubtitleTranslation = {
  segment_id: string;
  text: string;
};

export function buildSubtitleResponse(
  segments: SubtitleSourceSegment[],
  translations: SubtitleTranslation[],
) {
  const bySegment = new Map(
    translations.map((translation) => [
      translation.segment_id,
      translation.text.trim(),
    ]),
  );
  return segments.map((segment) => {
    const totalSeconds = Math.floor(segment.start_ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return {
      id: segment.id,
      time: `${minutes.toString().padStart(2, "0")}:${
        seconds.toString().padStart(2, "0")
      }`,
      startMs: segment.start_ms,
      endMs: segment.end_ms,
      original: segment.text,
      sinhala: bySegment.get(segment.id) || null,
    };
  });
}
