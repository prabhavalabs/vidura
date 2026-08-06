import { describe, expect, test } from "bun:test";

process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.BETTER_AUTH_SECRET ??= "test-auth-secret";
process.env.TRANSLATION_PROVIDER = "openai";
process.env.OPENAI_API_KEY = "test-openai-key";
process.env.OPENAI_MODEL = "gpt-5.6-terra";

const {
  buildTranslationContextOpenAI,
  finalizeTranslationResults,
  parseTranslationStreamPayload,
  translateTranscriptOpenAI,
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

describe("translateTranscriptOpenAI", () => {
  test("sends Terra the Vidura Sinhala voice and video terminology context", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<Record<string, any>> = [];
    globalThis.fetch = (async (
      _input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      requests.push(JSON.parse(String(init?.body)));
      const content = JSON.stringify({
        translations: [{
          index: 0,
          src: "Autophagy recycles damaged cell components.",
          text: "Autophagy ක්‍රියාවලියෙන් හානි වූ සෛල කොටස් නැවත භාවිතයට ගන්නවා.",
        }],
      });
      const event = JSON.stringify({
        id: "chatcmpl_quality",
        model: "gpt-5.6-terra",
        choices: [{ delta: { content }, finish_reason: "stop" }],
      });
      return new Response(`data: ${event}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;

    try {
      const results = await translateTranscriptOpenAI({
        segments: [{
          index: 0,
          startMs: 0,
          endMs: 4_000,
          text: "Autophagy recycles damaged cell components.",
        }],
        metadata: {
          title: "How cells repair themselves",
          channelTitle: "Science Class",
        },
        targetLanguage: "si-LK",
        translationContext: {
          topic: "Cell repair",
          summary: "How cells reuse damaged components.",
          audience: "Sri Lankan learners",
          translationGuidelines: "Use friendly contemporary spoken Sinhala.",
          keyTerms: [{ source: "Autophagy", preferredSinhala: "Autophagy" }],
        },
      });

      expect(results).toEqual([{
        index: 0,
        text: "Autophagy ක්‍රියාවලියෙන් හානි වූ සෛල කොටස් නැවත භාවිතයට ගන්නවා.",
      }]);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.reasoning_effort).toBe("medium");

      const system = requests[0]!.messages[0].content as string;
      expect(system).toContain("Sinhala (Sri Lanka)");
      expect(system).toContain("VIDURA SINHALA VOICE");
      expect(system).toContain("Autophagy → Autophagy");
      expect(system).toContain(
        "The takeaway is simple. → මේකෙන් මතක තියාගන්න ඕන දේ සරලයි.",
      );

      const user = JSON.parse(requests[0]!.messages[1].content);
      expect(user.targetLanguage).toBe("Sinhala (Sri Lanka)");
      expect(user.videoContext).toEqual({
        topic: "Cell repair",
        summary: "How cells reuse damaged components.",
        audience: "Sri Lankan learners",
        translationGuidelines: "Use friendly contemporary spoken Sinhala.",
        keyTerms: [{ source: "Autophagy", preferredSinhala: "Autophagy" }],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("carries recent Sinhala wording into the next translation window", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<Record<string, any>> = [];
    globalThis.fetch = (async (
      _input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      const request = JSON.parse(String(init?.body));
      requests.push(request);
      const user = JSON.parse(request.messages[1].content);
      const translations = user.translateIndices.map((index: number) => ({
        index,
        src: `Source line ${index} explains one`,
        text: `සිංහල පේළිය ${index}`,
      }));
      const event = JSON.stringify({
        id: `chatcmpl_window_${requests.length}`,
        model: "gpt-5.6-terra",
        choices: [{
          delta: { content: JSON.stringify({ translations }) },
          finish_reason: "stop",
        }],
      });
      return new Response(`data: ${event}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;

    try {
      const segments = Array.from({ length: 101 }, (_, index) => ({
        index,
        startMs: index * 4_000,
        endMs: (index + 1) * 4_000,
        text: `Source line ${index} explains one concept.`,
      }));
      await translateTranscriptOpenAI({
        segments,
        metadata: { title: "Long lesson", channelTitle: "Teacher" },
        targetLanguage: "si-LK",
      });

      expect(requests).toHaveLength(2);
      const secondUser = JSON.parse(requests[1]!.messages[1].content);
      expect(secondUser.translateIndices).toEqual([100]);
      expect(secondUser.priorSinhalaTranslations.length).toBeGreaterThan(0);
      expect(secondUser.priorSinhalaTranslations.length).toBeLessThanOrEqual(8);
      expect(secondUser.priorSinhalaTranslations.at(-1)).toEqual({
        index: 99,
        text: "සිංහල පේළිය 99",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("buildTranslationContextOpenAI", () => {
  test("builds a reusable video glossary through the selected OpenAI model", async () => {
    const originalFetch = globalThis.fetch;
    let request: any;
    const context = {
      topic: "Cell repair",
      summary: "How cells repair and recycle damaged components.",
      audience: "Sri Lankan learners interested in biology",
      translationGuidelines:
        "Use friendly contemporary spoken Sinhala and concise explanations.",
      keyTerms: [
        { source: "autophagy", preferredSinhala: "Autophagy ක්‍රියාවලිය" },
        { source: "DNA damage", preferredSinhala: "DNA හානිය" },
      ],
    };
    globalThis.fetch = (async (
      _input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      request = JSON.parse(String(init?.body));
      return Response.json({
        id: "chatcmpl_context",
        model: "gpt-5.6-terra",
        choices: [{
          message: { role: "assistant", content: JSON.stringify(context) },
          finish_reason: "stop",
        }],
      });
    }) as typeof fetch;

    try {
      const result = await buildTranslationContextOpenAI({
        sourceLanguage: "en",
        targetLanguage: "si-LK",
        videoTitle: "How cells repair themselves",
        channelTitle: "Science Class",
        segments: [{
          index: 0,
          startMs: 0,
          endMs: 4_000,
          text: "Autophagy recycles damaged cell components and limits DNA damage.",
        }],
      });

      expect(result).toEqual(context);
      expect(request?.model).toBe("gpt-5.6-terra");
      expect(request?.reasoning_effort).toBe("medium");
      expect(request?.response_format?.type).toBe("json_schema");
      expect(request?.messages[0].content).toContain("Sinhala (Sri Lanka)");
      const user = JSON.parse(request?.messages[1].content);
      expect(user.targetLanguage).toBe("Sinhala (Sri Lanka)");
      expect(user.transcript).toEqual([{
        index: 0,
        text: "Autophagy recycles damaged cell components and limits DNA damage.",
      }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
