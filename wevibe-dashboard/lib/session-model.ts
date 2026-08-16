/**
 * Normalize an OpenCode session model to its provider-native slug AND surface
 * the producer's provider.
 *
 * OpenCode records the session model as a JSON-stringified structured object
 * `{"id":"anthropic/claude-opus-4.8","providerID":"openrouter","variant":"xhigh"}`.
 * Provider readiness checks and the extraction call need the bare provider slug
 * (`.id`, e.g. `anthropic/claude-opus-4.8`) — NOT the stringified object. An
 * extraction-override model is already a plain slug and passes through unchanged.
 *
 * `resolveSessionModel` returns the slug PLUS the producer's `providerID`
 * (absent for plain slugs or records without a string `providerID`).
 * `resolveSessionModelSlug` is the backward-compatible slug-only wrapper.
 * `resolveExtractionProvider` routes an `orcarouter` producer to `orcarouter`,
 * otherwise returning the caller's fallback provider.
 */
export interface ResolvedSessionModel {
  slug: string;
  providerID?: string;
}

export function resolveSessionModel(raw: string): ResolvedSessionModel {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { slug: '' };
  if (trimmed[0] !== '{') return { slug: trimmed }; // already a plain slug
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      parsed !== null
      && typeof parsed === 'object'
      && typeof (parsed as { id?: unknown }).id === 'string'
    ) {
      const record = parsed as { id: string; providerID?: unknown };
      const providerID =
        typeof record.providerID === 'string' && record.providerID.trim().length > 0
          ? record.providerID.trim()
          : undefined;
      return { slug: record.id.trim(), providerID };
    }
  } catch {
    // not valid JSON — treat as an already-plain slug
  }
  return { slug: trimmed };
}

export function resolveSessionModelSlug(raw: string): string {
  return resolveSessionModel(raw).slug;
}

export function resolveExtractionProvider(
  producerProvider: string | undefined,
  fallbackProvider: string,
): string {
  return producerProvider === 'orcarouter' ? 'orcarouter' : fallbackProvider;
}
