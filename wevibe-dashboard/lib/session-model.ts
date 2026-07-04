/**
 * Normalize an OpenCode session model to its provider-native slug.
 *
 * OpenCode records the session model as a JSON-stringified structured object
 * `{"id":"anthropic/claude-opus-4.8","providerID":"openrouter","variant":"xhigh"}`.
 * Provider readiness checks and the extraction call need the bare provider slug
 * (`.id`, e.g. `anthropic/claude-opus-4.8`) — NOT the stringified object. An
 * extraction-override model is already a plain slug and passes through unchanged.
 * We deliberately do NOT translate slugs across providers (deferred GAP-MI-3.3):
 * we only extract `.id`.
 */
export function resolveSessionModelSlug(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '';
  if (trimmed[0] !== '{') return trimmed; // already a plain slug
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      parsed !== null
      && typeof parsed === 'object'
      && typeof (parsed as { id?: unknown }).id === 'string'
    ) {
      return (parsed as { id: string }).id.trim();
    }
  } catch {
    // not valid JSON — treat as an already-plain slug
  }
  return trimmed;
}
