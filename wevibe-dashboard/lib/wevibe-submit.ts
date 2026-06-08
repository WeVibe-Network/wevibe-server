import { buildAuthHeaders, getIdentity, signWithIdentity } from './wevibe-auth';
import {
  submitMemoryCanonical,
  type MemoryType,
} from './wevibe-signing';
import { encryptSymmetric, sealToPubkey } from './wevibe-crypto';
import type { SanitizationFinding } from './hub-client';

function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBuf(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function concatBufs(...bufs: Uint8Array[]): Uint8Array {
  const total = bufs.reduce((sum, b) => sum + b.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const buf of bufs) {
    result.set(buf, offset);
    offset += buf.length;
  }
  return result;
}

export function generateDek(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

export async function encryptMemory(
  plaintext: string,
  dek: Uint8Array,
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const data = encoder.encode(plaintext);
  return encryptSymmetric(data, dek);
}

export async function sealDekToModPubkey(
  dek: Uint8Array,
  modPubkeyHex: string,
): Promise<Uint8Array> {
  const modPubkeyBytes = hexToBuf(modPubkeyHex);
  return sealToPubkey(dek, modPubkeyBytes);
}

export async function computeSubmissionHash(
  ciphertext: Uint8Array,
  wrappedDek: Uint8Array,
): Promise<Uint8Array> {
  const data = concatBufs(ciphertext, wrappedDek);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data.buffer as ArrayBuffer);
  return new Uint8Array(hashBuffer);
}

export interface SubmitMemoryParams {
  memoryText: string;
  stackHint: string[];
  orgId: string;
  epochId: number;
  memoryType: MemoryType;
  preferenceConfidence: number;
  derivation: string;
  modPubkeyHex: string;
  hubUrl: string;
}

export interface SubmitMemoryPayload {
  org_id: string;
  epoch_id: number;
  memory_type: MemoryType;
  plaintext_hash: string;
  salt: string;
  ciphertext_hash: string;
  wrapped_dek_hash: string;
  ciphertext: string;
  wrapped_dek_mod: string;
  submission_hash: string;
  contributor_pubkey: string;
  contributor_sig: string;
  stack_hint: string[];
  preference_confidence: number;
  derivation: string;
  attestation: null;
}

export interface BatchSubmitResult {
  submission_hash: string;
  status: 'pending' | 'buffered' | 'error';
  error?: string;
  sanitization_findings?: SanitizationFinding[] | null;
}

export interface BatchSubmitResponse {
  submitted: number;
  failed: number;
  results: BatchSubmitResult[];
}

export async function buildSubmitMemoryPayload(
  params: SubmitMemoryParams,
): Promise<{ status: 'ok'; payload: SubmitMemoryPayload } | { status: 'error'; error: string }> {
  const {
    memoryText,
    stackHint,
    orgId,
    epochId,
    memoryType,
    preferenceConfidence,
    derivation,
    modPubkeyHex,
  } = params;

	if (memoryType !== 'memory') {
		return { status: 'error', error: 'memory_type is required for submission' };
	}

  const identity = await getIdentity();
  if (!identity) {
    return { status: 'error', error: 'No identity. Generate one first in Settings.' };
  }

  const dek = generateDek();
  const fullCiphertext = await encryptMemory(memoryText, dek);
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const plaintextBytes = new TextEncoder().encode(memoryText);
  const plaintextHashBuffer = await crypto.subtle.digest(
    'SHA-256',
    concatBufs(salt, plaintextBytes).buffer as ArrayBuffer,
  );
  const plaintextHashHex = bufToHex(plaintextHashBuffer);
  const saltHex = bufToHex(salt.buffer as ArrayBuffer);

  const wrappedDek = await sealDekToModPubkey(dek, modPubkeyHex);
  const wrappedDekHashBuffer = await crypto.subtle.digest(
    'SHA-256',
    wrappedDek.buffer as ArrayBuffer,
  );
  const wrappedDekHashHex = bufToHex(wrappedDekHashBuffer);

  const ciphertextHashBuffer = await crypto.subtle.digest(
    'SHA-256',
    fullCiphertext.buffer as ArrayBuffer,
  );
  const ciphertextHashHex = bufToHex(ciphertextHashBuffer);
  const submissionHashBytes = await computeSubmissionHash(
    fullCiphertext,
    wrappedDek,
  );
  const submissionHashHex = bufToHex(submissionHashBytes.buffer as ArrayBuffer);

	const canonical = await submitMemoryCanonical(
		orgId,
		epochId,
		submissionHashHex,
		identity.pubkeyHex,
		memoryType,
		ciphertextHashHex,
		plaintextHashHex,
		saltHex,
		wrappedDekHashHex,
	);
  const signatureHex = await signWithIdentity(canonical);

  return {
    status: 'ok',
    payload: {
      org_id: orgId,
      epoch_id: epochId,
      memory_type: memoryType,
      plaintext_hash: plaintextHashHex,
      salt: saltHex,
      ciphertext_hash: ciphertextHashHex,
      wrapped_dek_hash: wrappedDekHashHex,
      ciphertext: bufToHex(fullCiphertext.buffer as ArrayBuffer),
      wrapped_dek_mod: bufToHex(wrappedDek.buffer as ArrayBuffer),
      submission_hash: submissionHashHex,
      contributor_pubkey: identity.pubkeyHex,
      contributor_sig: signatureHex,
      stack_hint: stackHint,
      preference_confidence: preferenceConfidence,
      derivation,
      attestation: null,
    },
  };
}

export async function submitMemoryBatchToHub(
  hubUrl: string,
  orgId: string,
  submissions: SubmitMemoryPayload[],
): Promise<BatchSubmitResponse> {
  const authHeaders = await buildAuthHeaders();
  const resp = await fetch(`${hubUrl}/v1/orgs/${orgId}/submit/batch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
    },
    body: JSON.stringify({ submissions }),
  });

  if (!resp.ok) {
    const err = (await resp.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `HTTP ${resp.status}`);
  }

  return (await resp.json()) as BatchSubmitResponse;
}

export async function submitMemoryToHub(
  params: SubmitMemoryParams,
): Promise<{ status: string; submissionHash?: string; error?: string; sanitizationFindings?: SanitizationFinding[] | null }> {
  const { orgId, hubUrl } = params;
  const prepared = await buildSubmitMemoryPayload(params);
  if (prepared.status !== 'ok') {
    return { status: 'error', error: prepared.error };
  }

  const payload = prepared.payload;

  try {
    const authHeaders = await buildAuthHeaders();
    const resp = await fetch(`${hubUrl}/v1/orgs/${orgId}/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify(payload),
    });

    if (resp.ok) {
      const data = (await resp.json()) as { submission_hash?: string; sanitization_findings?: SanitizationFinding[] | null };
      return {
        status: 'ok',
        submissionHash: data.submission_hash ?? payload.submission_hash,
        sanitizationFindings: data.sanitization_findings ?? null,
      };
    } else {
      const err = (await resp.json().catch(() => ({}))) as { error?: string };
      return {
        status: 'error',
        error: err.error ?? `HTTP ${resp.status}`,
      };
    }
  } catch (err) {
    return {
      status: 'error',
      error: (err as Error).message,
    };
  }
}
