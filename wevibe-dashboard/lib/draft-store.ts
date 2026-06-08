import type { MemoryCandidate } from './session-types';

export interface ExtractionDraft {
  sessionId: string;
  sessionTitle?: string;
  sessionDirectory?: string;
  memories: MemoryCandidate[];
  extractionMeta?: {
    provider?: string;
    model?: string;
    is_local?: boolean;
    num_ctx?: number;
    source?: string;
    preset_id?: string | null;
    prompt_fingerprint?: string;
  };
  createdAt: number;
}

interface DraftStorePayload {
  version: 1;
  drafts: Record<string, ExtractionDraft>;
}

const STORAGE_VERSION = 1;

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

function normalizePubkey(pubkeyHex: string): string | null {
  if (typeof pubkeyHex !== 'string') {
    return null;
  }

  const trimmed = pubkeyHex.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getStorageKey(pubkeyHex: string): string | null {
  const normalized = normalizePubkey(pubkeyHex);
  if (!normalized) {
    return null;
  }

  return `wevibe.drafts.v1.${normalized}`;
}

function emptyPayload(): DraftStorePayload {
  return { version: STORAGE_VERSION, drafts: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPayload(pubkeyHex: string): DraftStorePayload {
  if (!isBrowser()) {
    return emptyPayload();
  }

  const key = getStorageKey(pubkeyHex);
  if (!key) {
    return emptyPayload();
  }

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return emptyPayload();
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return emptyPayload();
    }

    if (parsed.version !== STORAGE_VERSION || !isRecord(parsed.drafts)) {
      return emptyPayload();
    }

    return {
      version: STORAGE_VERSION,
      drafts: parsed.drafts as Record<string, ExtractionDraft>,
    };
  } catch {
    return emptyPayload();
  }
}

function writePayload(pubkeyHex: string, drafts: Record<string, ExtractionDraft>): void {
  if (!isBrowser()) {
    return;
  }

  const key = getStorageKey(pubkeyHex);
  if (!key) {
    return;
  }

  try {
    const payload: DraftStorePayload = {
      version: STORAGE_VERSION,
      drafts,
    };
    window.localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // no-op on storage quota or serialization failures
  }
}

export function loadDrafts(pubkeyHex: string): Record<string, ExtractionDraft> {
  return { ...readPayload(pubkeyHex).drafts };
}

export function getDraft(pubkeyHex: string, sessionId: string): ExtractionDraft | null {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    return null;
  }

  const drafts = readPayload(pubkeyHex).drafts;
  return drafts[normalizedSessionId] ?? null;
}

export function saveDraft(pubkeyHex: string, draft: ExtractionDraft): void {
  const normalizedSessionId = draft.sessionId.trim();
  if (!normalizedSessionId) {
    return;
  }

  const drafts = readPayload(pubkeyHex).drafts;
  drafts[normalizedSessionId] = {
    ...draft,
    sessionId: normalizedSessionId,
  };
  writePayload(pubkeyHex, drafts);
}

export function deleteDraft(pubkeyHex: string, sessionId: string): void {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    return;
  }

  const drafts = readPayload(pubkeyHex).drafts;
  if (!(normalizedSessionId in drafts)) {
    return;
  }

  delete drafts[normalizedSessionId];
  writePayload(pubkeyHex, drafts);
}

export function clearDrafts(pubkeyHex: string): void {
  if (!isBrowser()) {
    return;
  }

  const key = getStorageKey(pubkeyHex);
  if (!key) {
    return;
  }

  try {
    window.localStorage.removeItem(key);
  } catch {
    // no-op on storage failures
  }
}
