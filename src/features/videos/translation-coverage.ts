export function translationCoveragePercent(
  metadata: Record<string, unknown>,
): number | null {
  const total = Number(metadata.total_segments);
  const translated = Number(metadata.translated_segments);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(translated)) {
    return null;
  }
  return Math.min(100, Math.max(0, Math.round((translated / total) * 100)));
}
