import { describe, expect, test } from "bun:test";
import { translationCoveragePercent } from "../src/features/videos/translation-coverage.ts";

describe("translationCoveragePercent", () => {
  test("reports persisted translation coverage independently of timing", () => {
    expect(translationCoveragePercent({
      total_segments: 246,
      translated_segments: 8,
    })).toBe(3);
  });

  test("clamps ready and malformed counts", () => {
    expect(translationCoveragePercent({
      total_segments: 2,
      translated_segments: 3,
    })).toBe(100);
    expect(translationCoveragePercent({
      total_segments: 2,
      translated_segments: -1,
    })).toBe(0);
  });

  test("returns null without a positive total", () => {
    expect(translationCoveragePercent({})).toBeNull();
    expect(translationCoveragePercent({ total_segments: 0 })).toBeNull();
  });
});
