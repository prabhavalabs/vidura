export type TranslationCoverage = {
  complete: boolean;
  completed: number;
  total: number;
  missingIndices: number[];
  unexpectedIndices: number[];
  duplicateIndices: number[];
  blankIndices: number[];
};

export class IncompleteTranslationError extends Error {
  readonly completed: number;
  readonly total: number;
  readonly missingIndices: number[];
  readonly unexpectedIndices: number[];
  readonly duplicateIndices: number[];
  readonly blankIndices: number[];

  constructor(coverage: TranslationCoverage) {
    super(
      `Translation incomplete: ${coverage.completed}/${coverage.total} segments ` +
        `(${coverage.missingIndices.length} missing)`,
    );
    this.name = "IncompleteTranslationError";
    this.completed = coverage.completed;
    this.total = coverage.total;
    this.missingIndices = coverage.missingIndices;
    this.unexpectedIndices = coverage.unexpectedIndices;
    this.duplicateIndices = coverage.duplicateIndices;
    this.blankIndices = coverage.blankIndices;
  }
}

export function translationCoverage(
  sourceIndices: Iterable<number>,
  translations: Iterable<{ index: number; text: string }>,
): TranslationCoverage {
  const expected = new Set(sourceIndices);
  const seen = new Map<number, number>();
  const valid = new Set<number>();
  const unexpected = new Set<number>();
  const blank = new Set<number>();

  for (const translation of translations) {
    seen.set(translation.index, (seen.get(translation.index) ?? 0) + 1);
    if (!expected.has(translation.index)) {
      unexpected.add(translation.index);
      continue;
    }
    if (!translation.text.trim()) {
      blank.add(translation.index);
      continue;
    }
    valid.add(translation.index);
  }

  const numericSort = (a: number, b: number) => a - b;
  const missingIndices = [...expected]
    .filter((index) => !seen.has(index))
    .sort(numericSort);
  const unexpectedIndices = [...unexpected].sort(numericSort);
  const duplicateIndices = [...seen]
    .filter(([, count]) => count > 1)
    .map(([index]) => index)
    .sort(numericSort);
  const blankIndices = [...blank].sort(numericSort);
  const completed = valid.size;
  const total = expected.size;

  return {
    complete:
      completed === total &&
      missingIndices.length === 0 &&
      unexpectedIndices.length === 0 &&
      duplicateIndices.length === 0 &&
      blankIndices.length === 0,
    completed,
    total,
    missingIndices,
    unexpectedIndices,
    duplicateIndices,
    blankIndices,
  };
}

export function assertCompleteTranslationCoverage(
  sourceIndices: Iterable<number>,
  translations: Iterable<{ index: number; text: string }>,
): TranslationCoverage {
  const coverage = translationCoverage(sourceIndices, translations);
  if (!coverage.complete) throw new IncompleteTranslationError(coverage);
  return coverage;
}
