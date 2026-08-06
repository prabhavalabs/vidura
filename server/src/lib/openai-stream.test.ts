import { describe, expect, test } from "bun:test";

process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.BETTER_AUTH_SECRET ??= "test-auth-secret";
process.env.TRANSLATION_PROVIDER = "openai";
process.env.OPENAI_API_KEY = "test-openai-key";
process.env.OPENAI_MODEL = "gpt-5.6-terra";

const {
  finalizeTranslationResults,
  parseTranslationStreamPayload,
} = await import("./openai.ts");
const { IncompleteTranslationError } = await import(
  "./translation-coverage.ts"
);

describe("parseTranslationStreamPayload", () => {
  test("returns streamed content and safe response metadata", () => {
    expect(parseTranslationStreamPayload(JSON.stringify({
      id: "chatcmpl_test",
      model: "gpt-5.6-terra-2026-08-01",
      choices: [{
        delta: { content: "{\"translations\":[" },
        finish_reason: null,
      }],
    }))).toEqual({
      content: "{\"translations\":[",
      finishReason: null,
      responseId: "chatcmpl_test",
      model: "gpt-5.6-terra-2026-08-01",
    });
  });

  test("returns a non-stop finish reason without inventing content", () => {
    expect(parseTranslationStreamPayload(JSON.stringify({
      id: "chatcmpl_test",
      choices: [{ delta: {}, finish_reason: "length" }],
    }))).toEqual({
      content: null,
      finishReason: "length",
      responseId: "chatcmpl_test",
      model: null,
    });
  });

  test("surfaces provider error events", () => {
    expect(() => parseTranslationStreamPayload(JSON.stringify({
      error: {
        message: "rate limited",
        code: "rate_limit_exceeded",
      },
    }))).toThrow("OpenAI stream error: rate limited (rate_limit_exceeded)");
  });
});

describe("finalizeTranslationResults", () => {
  test("orders a complete result by source index", () => {
    expect(finalizeTranslationResults([2, 0, 1], new Map([
      [0, "ශුන්‍ය"],
      [1, "එක"],
      [2, "දෙක"],
    ]))).toEqual([
      { index: 2, text: "දෙක" },
      { index: 0, text: "ශුන්‍ය" },
      { index: 1, text: "එක" },
    ]);
  });

  test("rejects partial results", () => {
    expect(() => finalizeTranslationResults(
      [0, 1],
      new Map([[0, "පළමු"]]),
    )).toThrow(IncompleteTranslationError);
  });
});
