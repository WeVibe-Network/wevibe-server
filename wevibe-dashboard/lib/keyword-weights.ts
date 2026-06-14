import type {
  KeywordSuggestionPayload,
  KeywordWeight,
} from './hub-client';

export type { KeywordWeight } from './hub-client';

export function normalizeKeywordWeights(input: unknown): KeywordWeight[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((entry): KeywordWeight | null => {
      const candidate = entry as {
        keyword?: unknown;
        weight?: unknown;
        base_weight?: unknown;
      };
      const keyword = typeof candidate.keyword === 'string' ? candidate.keyword.trim() : '';
      const weight = typeof candidate.weight === 'number' ? candidate.weight : Number(candidate.weight);

      if (!keyword || !Number.isFinite(weight) || weight < 0) {
        return null;
      }

      const parsedBaseWeight = typeof candidate.base_weight === 'number'
        ? candidate.base_weight
        : Number(candidate.base_weight);
      const baseWeight = Number.isFinite(parsedBaseWeight) ? parsedBaseWeight : weight;

      return { keyword, weight, base_weight: baseWeight };
    })
    .filter((entry): entry is KeywordWeight => entry !== null);
}

export function renormalizeFromBase(included: KeywordWeight[]): KeywordWeight[] {
  const cleaned = normalizeKeywordWeights(included);
  if (cleaned.length === 0) {
    return [];
  }

  const totalBase = cleaned.reduce((sum, keyword) => sum + (keyword.base_weight ?? keyword.weight), 0);
  let normalized: KeywordWeight[];

  if (totalBase <= 0) {
    const uniform = 1 / cleaned.length;
    normalized = cleaned.map((keyword) => ({
      keyword: keyword.keyword,
      weight: uniform,
      base_weight: keyword.base_weight,
    }));
  } else {
    normalized = cleaned.map((keyword) => ({
      keyword: keyword.keyword,
      weight: (keyword.base_weight ?? keyword.weight) / totalBase,
      base_weight: keyword.base_weight,
    }));
  }

  const normalizedTotal = normalized.reduce((sum, keyword) => sum + keyword.weight, 0);
  const correction = 1 - normalizedTotal;
  const lastIndex = normalized.length - 1;
  normalized[lastIndex] = {
    ...normalized[lastIndex],
    weight: Math.max(0, normalized[lastIndex].weight + correction),
  };

  return normalized;
}

export function toExcludedSuggestionPayload(suggestions: KeywordWeight[]): KeywordSuggestionPayload[] {
  return normalizeKeywordWeights(suggestions).map((suggestion) => ({
    keyword: suggestion.keyword,
    weight: suggestion.weight,
    base_weight: suggestion.base_weight,
    rationale: 'excluded',
  }));
}

export function displayWeight(kw: KeywordWeight, included: boolean): number {
  return included ? kw.weight : kw.base_weight ?? kw.weight;
}
