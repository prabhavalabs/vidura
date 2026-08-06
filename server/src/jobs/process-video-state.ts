import type { TranslationContext } from "../lib/translation.ts";
import { IncompleteTranslationError } from "../lib/translation-coverage.ts";

export type ProcessVideoFailureState = {
  progress: number;
  errorMessage: string;
  metadata: Record<string, unknown>;
};

export function failureState(
  error: unknown,
  currentProgress: number,
): ProcessVideoFailureState {
  const errorMessage = error instanceof Error
    ? error.message
    : typeof error === "string" && error
    ? error
    : "Processing failed";
  const progress = Number.isFinite(currentProgress)
    ? Math.min(99, Math.max(0, Math.floor(currentProgress)))
    : 0;

  if (error instanceof IncompleteTranslationError) {
    return {
      progress,
      errorMessage,
      metadata: {
        stage: "failed",
        error: errorMessage,
        total_segments: error.total,
        translated_segments: error.completed,
        remaining_segments: error.total - error.completed,
        missing_segment_indices: error.missingIndices.slice(0, 50),
      },
    };
  }

  return {
    progress,
    errorMessage,
    metadata: { stage: "failed", error: errorMessage },
  };
}

export async function resolveTranslationContext(input: {
  existing: TranslationContext | null;
  rebuild: boolean;
  build: () => Promise<TranslationContext>;
  persist: (context: TranslationContext) => Promise<void>;
}): Promise<TranslationContext> {
  if (!input.rebuild && input.existing) return input.existing;

  const context = await input.build();
  await input.persist(context);
  return context;
}
