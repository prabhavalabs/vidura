import { describe, expect, test } from "bun:test";
import {
  assertCompleteTranslationCoverage,
  IncompleteTranslationError,
  translationCoverage,
} from "./translation-coverage.ts";

describe("translationCoverage", () => {
  test("accepts exactly one non-empty translation for every source index", () => {
    const coverage = translationCoverage([0, 1], [
      { index: 0, text: "පළමු" },
      { index: 1, text: "දෙවන" },
    ]);

    expect(coverage).toEqual({
      complete: true,
      completed: 2,
      total: 2,
      missingIndices: [],
      unexpectedIndices: [],
      duplicateIndices: [],
      blankIndices: [],
    });
  });

  test("reports missing, unexpected, duplicate, and blank translations", () => {
    const coverage = translationCoverage([0, 1, 2], [
      { index: 0, text: "පළමු" },
      { index: 0, text: "නැවත" },
      { index: 1, text: "   " },
      { index: 9, text: "අමතර" },
    ]);

    expect(coverage).toEqual({
      complete: false,
      completed: 1,
      total: 3,
      missingIndices: [2],
      unexpectedIndices: [9],
      duplicateIndices: [0],
      blankIndices: [1],
    });
  });

  test("throws a typed error containing actionable coverage details", () => {
    try {
      assertCompleteTranslationCoverage([0, 1, 2], [
        { index: 0, text: "පළමු" },
      ]);
      throw new Error("expected coverage assertion to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(IncompleteTranslationError);
      expect(error).toMatchObject({
        completed: 1,
        total: 3,
        missingIndices: [1, 2],
        unexpectedIndices: [],
        duplicateIndices: [],
        blankIndices: [],
      });
    }
  });
});
