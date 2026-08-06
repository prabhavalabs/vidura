import { describe, expect, test } from "bun:test";
import { buildSubtitleResponse } from "./subtitle-response.ts";

describe("buildSubtitleResponse", () => {
  test("represents a missing Sinhala translation as null instead of English", () => {
    expect(buildSubtitleResponse(
      [{ id: "a", start_ms: 0, end_ms: 1000, text: "English source" }],
      [],
    )).toEqual([{
      id: "a",
      time: "00:00",
      startMs: 0,
      endMs: 1000,
      original: "English source",
      sinhala: null,
    }]);
  });

  test("returns a trimmed persisted Sinhala translation", () => {
    expect(buildSubtitleResponse(
      [{ id: "a", start_ms: 65_000, end_ms: 66_000, text: "English" }],
      [{ segment_id: "a", text: "  සිංහල  " }],
    )).toEqual([{
      id: "a",
      time: "01:05",
      startMs: 65_000,
      endMs: 66_000,
      original: "English",
      sinhala: "සිංහල",
    }]);
  });

  test("treats a blank persisted translation as missing", () => {
    const [segment] = buildSubtitleResponse(
      [{ id: "a", start_ms: 0, end_ms: 1000, text: "English" }],
      [{ segment_id: "a", text: "   " }],
    );

    expect(segment?.sinhala).toBeNull();
  });
});
