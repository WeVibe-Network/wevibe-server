import type { MemoryCandidate } from './session-types';

export interface ExtractionDraft {
  sessionId: string;
  sessionTitle?: string;
  sessionDirectory?: string;
  memories: MemoryCandidate[];
  extractionMeta?: {
    provider?: string;
    model?: string;
    session_model?: string;
    is_local?: boolean;
    num_ctx?: number;
    source?: string;
    preset_id?: string | null;
    prompt_fingerprint?: string;
    empty_reason?: string;
  };
  createdAt: number;
}

interface DraftStorePayload {
  version: 1;
  drafts: Record<string, ExtractionDraft>;
}

const STORAGE_VERSION = 1;
const DRAFT_STORAGE_PREFIX = 'wevibe.drafts.';
const DRAFT_STORAGE_KEY_PREFIX = `${DRAFT_STORAGE_PREFIX}v1.`;
const BACKEND_INSTANCE_STORAGE_KEY = 'wevibe.backend-instance.v1';

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

  return `${DRAFT_STORAGE_KEY_PREFIX}${normalized}`;
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

export function reconcileBackendInstance(instanceId: string): { cleared: boolean } {
  if (!isBrowser()) {
    return { cleared: false };
  }

  const normalizedInstanceId = instanceId.trim();
  if (!normalizedInstanceId) {
    return { cleared: false };
  }

  try {
    const storedInstanceId = window.localStorage.getItem(BACKEND_INSTANCE_STORAGE_KEY);

    if (!storedInstanceId) {
      window.localStorage.setItem(BACKEND_INSTANCE_STORAGE_KEY, normalizedInstanceId);
      return { cleared: false };
    }

    if (storedInstanceId === normalizedInstanceId) {
      return { cleared: false };
    }

    const draftKeys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key && key.startsWith(DRAFT_STORAGE_PREFIX)) {
        draftKeys.push(key);
      }
    }

    for (const key of draftKeys) {
      window.localStorage.removeItem(key);
    }

    window.localStorage.setItem(BACKEND_INSTANCE_STORAGE_KEY, normalizedInstanceId);
    return { cleared: true };
  } catch {
    return { cleared: false };
  }
}
