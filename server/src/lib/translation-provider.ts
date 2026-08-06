export type TranslationProviderConfig = {
  url: string;
  apiKey: string;
  model: string;
  jsonSchema: boolean;
  openrouter: boolean;
};

export type TranslationProviderInput = {
  provider: string;
  openaiApiKey: string;
  openaiModel: string;
  openRouterApiKey: string;
  openRouterModel: string;
};

export function resolveTranslationProviderConfig(
  input: TranslationProviderInput,
): TranslationProviderConfig {
  const provider = input.provider.trim().toLowerCase();

  if (provider === "openai") {
    if (!input.openaiApiKey.trim()) {
      throw new Error(
        "OPENAI_API_KEY is required when TRANSLATION_PROVIDER=openai",
      );
    }
    return {
      url: "https://api.openai.com/v1/chat/completions",
      apiKey: input.openaiApiKey.trim(),
      model: input.openaiModel,
      jsonSchema: true,
      openrouter: false,
    };
  }

  if (provider === "deepseek") {
    if (!input.openRouterApiKey.trim()) {
      throw new Error(
        "OPENROUTER_API_KEY is required when TRANSLATION_PROVIDER=deepseek",
      );
    }
    return {
      url: "https://openrouter.ai/api/v1/chat/completions",
      apiKey: input.openRouterApiKey.trim(),
      model: input.openRouterModel,
      jsonSchema: false,
      openrouter: true,
    };
  }

  throw new Error(`Unsupported TRANSLATION_PROVIDER: ${input.provider}`);
}
