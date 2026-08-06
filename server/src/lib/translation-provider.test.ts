import { describe, expect, test } from "bun:test";
import { resolveTranslationProviderConfig } from "./translation-provider.ts";

const configured = {
  provider: "openai",
  openaiApiKey: "test-openai-key",
  openaiModel: "gpt-5.6-terra",
  openRouterApiKey: "test-router-key",
  openRouterModel: "deepseek/deepseek-v4-flash",
};

describe("resolveTranslationProviderConfig", () => {
  test("selects direct OpenAI with strict JSON Schema", () => {
    expect(resolveTranslationProviderConfig(configured)).toEqual({
      url: "https://api.openai.com/v1/chat/completions",
      apiKey: "test-openai-key",
      model: "gpt-5.6-terra",
      jsonSchema: true,
      openrouter: false,
    });
  });

  test("does not silently fall back when the selected OpenAI key is missing", () => {
    expect(() => resolveTranslationProviderConfig({
      ...configured,
      openaiApiKey: "",
    })).toThrow("OPENAI_API_KEY is required when TRANSLATION_PROVIDER=openai");
  });

  test("selects OpenRouter only when DeepSeek is explicitly selected", () => {
    expect(resolveTranslationProviderConfig({
      ...configured,
      provider: "deepseek",
    })).toEqual({
      url: "https://openrouter.ai/api/v1/chat/completions",
      apiKey: "test-router-key",
      model: "deepseek/deepseek-v4-flash",
      jsonSchema: false,
      openrouter: true,
    });
  });

  test("rejects unsupported provider names", () => {
    expect(() => resolveTranslationProviderConfig({
      ...configured,
      provider: "automatic",
    })).toThrow("Unsupported TRANSLATION_PROVIDER: automatic");
  });
});
