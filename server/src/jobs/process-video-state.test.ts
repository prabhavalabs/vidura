import { describe, expect, test } from "bun:test";
import { IncompleteTranslationError } from "../lib/translation-coverage.ts";
import {
  failureState,
  resolveTranslationContext,
} from "./process-video-state.ts";

describe("failureState", () => {
  test("preserves incomplete translation counts below 100 percent", () => {
    const missingIndices = Array.from({ length: 238 }, (_, index) => index + 8);
    const error = new IncompleteTranslationError({
      complete: false,
      completed: 8,
      total: 246,
      missingIndices,
      unexpectedIndices: [],
      duplicateIndices: [],
      blankIndices: [],
    });

    expect(failureState(error, 27)).toEqual({
      progress: 27,
      errorMessage: "Translation incomplete: 8/246 segments (238 missing)",
      metadata: {
        stage: "failed",
        error: "Translation incomplete: 8/246 segments (238 missing)",
        total_segments: 246,
        translated_segments: 8,
        remaining_segments: 238,
        missing_segment_indices: missingIndices.slice(0, 50),
      },
    });
  });

  test("caps general failure progress below 100 percent", () => {
    expect(failureState(new Error("provider unavailable"), 100)).toEqual({
      progress: 99,
      errorMessage: "provider unavailable",
      metadata: {
        stage: "failed",
        error: "provider unavailable",
      },
    });
  });

  test("normalizes invalid current progress", () => {
    expect(failureState("unknown failure", Number.NaN).progress).toBe(0);
  });
});

describe("resolveTranslationContext", () => {
  test("builds and persists a reusable context when job metadata has none", async () => {
    const expected = {
      topic: "Cell repair",
      summary: "How cells repair themselves.",
      audience: "Sri Lankan learners",
      translationGuidelines: "Use natural spoken Sinhala.",
      keyTerms: [{ source: "DNA", preferredSinhala: "DNA" }],
    };
    let persisted: unknown = null;

    const result = await resolveTranslationContext({
      existing: null,
      rebuild: false,
      build: async () => expected,
      persist: async (context: unknown) => {
        persisted = context;
      },
    });

    expect(result).toEqual(expected);
    expect(persisted).toEqual(expected);
  });

  test("reuses a valid persisted context without another provider call", async () => {
    const existing = {
      topic: "Existing topic",
      summary: "Existing summary",
      audience: "Existing audience",
      translationGuidelines: "Existing guidance",
      keyTerms: [],
    };
    let builds = 0;
    let persists = 0;

    const result = await resolveTranslationContext({
      existing,
      rebuild: false,
      build: async () => {
        builds += 1;
        return { ...existing, topic: "Replacement" };
      },
      persist: async () => {
        persists += 1;
      },
    });

    expect(result).toEqual(existing);
    expect(builds).toBe(0);
    expect(persists).toBe(0);
  });
});
