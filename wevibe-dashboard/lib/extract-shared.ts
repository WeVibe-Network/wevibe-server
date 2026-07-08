import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type {
  ClassifiedKeyword,
  MemoryCandidate,
  MemoryCandidateKeywords,
  NearDupFlag,
  SuggestedKeyword,
} from './session-types.js';

const MCP_SESSION_TOKEN_PATH = path.join(
  homedir(),
  '.wevibe',
  'mcp-session-token',
);
const LAST_EXTRACTION_ERROR_PATH = path.join(
  homedir(),
  '.wevibe',
  'last-extraction-error.json',
);

export async function readMcpSessionToken(): Promise<string | null> {
  try {
    const token = (await readFile(MCP_SESSION_TOKEN_PATH, 'utf8')).trim();
    return token.length > 0 ? token : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function recordExtractionError(stage: string, status: number, message: string): Promise<void> {
  try {
    await writeFile(
      LAST_EXTRACTION_ERROR_PATH,
      JSON.stringify(
        {
          at: new Date().toISOString(),
          stage,
          status,
          message,
        },
        null,
        2,
      ),
      'utf8',
    );
  } catch {
    // best-effort observability only
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function emptyKeywords(): MemoryCandidateKeywords {
  return {
    classified: [],
    suggestions: [],
  };
}

function isClassifiedKeyword(value: unknown): value is ClassifiedKeyword {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.keyword === 'string'
    && typeof value.weight === 'number'
    && Number.isFinite(value.weight)
  );
}

function isSuggestedKeyword(value: unknown): value is SuggestedKeyword {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.keyword === 'string'
    && typeof value.weight === 'number'
    && Number.isFinite(value.weight)
    && typeof value.rationale === 'string'
  );
}

function normalizeKeywords(value: unknown): MemoryCandidateKeywords {
  if (!isRecord(value)) {
    return emptyKeywords();
  }

  const { classified, suggestions } = value;
  if (!Array.isArray(classified) || !Array.isArray(suggestions)) {
    return emptyKeywords();
  }

  if (!classified.every(isClassifiedKeyword) || !suggestions.every(isSuggestedKeyword)) {
    return emptyKeywords();
  }

  return {
    classified: classified.map((entry) => ({
      keyword: entry.keyword,
      weight: entry.weight,
    })),
    suggestions: suggestions.map((entry) => ({
      keyword: entry.keyword,
      weight: entry.weight,
      rationale: entry.rationale,
    })),
  };
}

function normalizeNearDup(value: unknown): NearDupFlag | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const { source, matched, score } = value;
  if (source !== 'injected_memory' && source !== 'intra_session') {
    return undefined;
  }

  if (typeof matched !== 'string' || matched.trim().length === 0) {
    return undefined;
  }

  if (typeof score !== 'number' || !Number.isFinite(score)) {
    return undefined;
  }

  return {
    source,
    matched,
    score,
  };
}

export function normalizeMemoryCandidate(value: unknown): MemoryCandidate | null {
  if (!isRecord(value)) {
    return null;
  }

  const {
    implement,
    context,
    dnd,
    stack,
    memory_type: memoryType,
    preference_confidence: preferenceConfidence,
    extraction_hash: extractionHash,
  } = value;

  if (typeof implement !== 'string' || typeof context !== 'string') {
    return null;
  }

  if (dnd !== null && typeof dnd !== 'string') {
    return null;
  }

  if (!Array.isArray(stack) || !stack.every((entry) => typeof entry === 'string')) {
    return null;
  }

  if (memoryType !== 'memory') {
    return null;
  }

  if (typeof preferenceConfidence !== 'number' || !Number.isFinite(preferenceConfidence)) {
    return null;
  }

  if (typeof extractionHash !== 'string') {
    return null;
  }

  const nearDup = normalizeNearDup(value.near_dup);
  const mc1 = isRecord(value.mc1) ? value.mc1 : undefined;
  const mcVersion = typeof mc1?.mc_version === 'number' && Number.isFinite(mc1.mc_version)
    ? mc1.mc_version
    : typeof value.mc_version === 'number' && Number.isFinite(value.mc_version)
      ? value.mc_version
      : undefined;

  return {
    implement,
    context,
    dnd,
    stack: [...stack],
    memory_type: memoryType,
    preference_confidence: preferenceConfidence,
    extraction_hash: extractionHash,
    ...(nearDup ? { near_dup: nearDup } : {}),
    keywords: normalizeKeywords(value.keywords),
    ...(mcVersion !== undefined ? { mc_version: mcVersion } : {}),
  };
}
