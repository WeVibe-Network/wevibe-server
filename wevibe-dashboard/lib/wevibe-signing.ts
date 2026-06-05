import { connectWallet, detectWallets, type WalletProvider } from './wallet-connect';

function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return bufToHex(hash);
}

async function feeModelHash(feeModel: Record<string, unknown> | null): Promise<string> {
  let canonical: string;
  if (!feeModel || Object.keys(feeModel).length === 0) {
    canonical = '{}';
  } else {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(feeModel).sort()) {
      sorted[key] = feeModel[key];
    }
    canonical = JSON.stringify(sorted);
  }
  return sha256Hex(canonical);
}

export async function createOrgCanonical(
  leaderPubkey: string,
  leaderX25519Pubkey: string,
  orgName: string,
  domain: string,
  encEnvelope: string,
  searchEnvelope: string,
  modEnvelope: string,
  pkMod: string,
  feeModel: Record<string, unknown> | null,
): Promise<Uint8Array> {
  const fmHash = await feeModelHash(feeModel);
  const msg = [
    'wevibe.create_org.v1',
    `domain:${domain}`,
    `enc_envelope:${encEnvelope}`,
    `fee_model_hash:${fmHash}`,
    `leader_pubkey:${leaderPubkey}`,
    `leader_x25519_pubkey:${leaderX25519Pubkey}`,
    `mod_envelope:${modEnvelope}`,
    `org_name:${orgName}`,
    `pk_mod:${pkMod}`,
    `search_envelope:${searchEnvelope}`,
  ].join('\n');
  return new TextEncoder().encode(msg);
}

export async function inviteMemberCanonical(
  orgId: string,
  pubkey: string,
  x25519Pubkey: string,
  role: string,
  signedBy: string,
  encEnvelope: string,
  searchEnvelope: string,
  modEnvelope: string,
): Promise<Uint8Array> {
  const msg = [
    'wevibe.invite_member.v1',
    `enc_envelope:${encEnvelope}`,
    `mod_envelope:${modEnvelope}`,
    `org_id:${orgId}`,
    `pubkey:${pubkey}`,
    `role:${role}`,
    `search_envelope:${searchEnvelope}`,
    `signed_by:${signedBy}`,
    `x25519_pubkey:${x25519Pubkey}`,
  ].join('\n');
  return new TextEncoder().encode(msg);
}

async function keywordsHash(keywords: { keyword: string; weight: number }[]): Promise<string> {
  const sorted = [...keywords].sort((a, b) => a.keyword.localeCompare(b.keyword));
  const entries = sorted.map(kw => `${kw.keyword}:${kw.weight.toFixed(6)}`);
  const joined = entries.join('\n');
  return sha256Hex(joined);
}

export type MemoryType = 'memory';

export async function submitMemoryCanonical(
	orgId: string,
	epochId: number,
	submissionHash: string,
	contributorPubkey: string,
	memoryType: MemoryType,
	ciphertextHash: string,
	plaintextHash: string,
	salt: string,
	wrappedDekHash: string,
): Promise<Uint8Array> {
  const msg = [
    'wevibe.submit_memory.v1',
    `ciphertext_hash:${ciphertextHash}`,
    `contributor_pubkey:${contributorPubkey}`,
    `epoch_id:${epochId}`,
    `memory_type:${memoryType}`,
    `org_id:${orgId}`,
    `plaintext_hash:${plaintextHash}`,
    `salt:${salt}`,
    `submission_hash:${submissionHash}`,
    `wrapped_dek_hash:${wrappedDekHash}`,
  ].join('\n');
  return new TextEncoder().encode(msg);
}

export async function approveSubmissionCanonical(
  orgId: string,
  submissionHash: string,
  epochId: number,
  approvedCid: string,
  wrappedDekEnc: string,
  signedBy: string,
  keywords: { keyword: string; weight: number }[],
): Promise<Uint8Array> {
  const kwHash = await keywordsHash(keywords);
  const msg = [
    'wevibe.approve_submission.v1',
    `approved_cid:${approvedCid}`,
    `keywords_hash:${kwHash}`,
    `epoch_id:${epochId}`,
    `org_id:${orgId}`,
    `signed_by:${signedBy}`,
    `submission_hash:${submissionHash}`,
    `wrapped_dek_enc:${wrappedDekEnc}`,
  ].join('\n');
  return new TextEncoder().encode(msg);
}

export async function denySubmissionCanonical(
  orgId: string,
  submissionHash: string,
  reason: string,
  signedBy: string,
): Promise<Uint8Array> {
  const msg = [
    'wevibe.deny_submission.v1',
    `org_id:${orgId}`,
    `reason:${reason}`,
    `signed_by:${signedBy}`,
    `submission_hash:${submissionHash}`,
  ].join('\n');
  return new TextEncoder().encode(msg);
}

export async function linkWalletCanonical(
  orgId: string,
  walletAddress: string,
  signedBy: string,
): Promise<Uint8Array> {
  const msg = [
    'wevibe.link_wallet.v1',
    `org_id:${orgId}`,
    `signed_by:${signedBy}`,
    `wallet_address:${walletAddress}`,
  ].join('\n');
  return new TextEncoder().encode(msg);
}

export async function signCanonical(
  privateKey: CryptoKey,
  canonicalMessage: Uint8Array,
): Promise<string> {
  const signature = await crypto.subtle.sign('Ed25519', privateKey, canonicalMessage as BufferSource);
  return bufToHex(signature);
}

// === CO-215 Task C additions ===

export async function updateMemberRoleCanonical(
  orgId: string,
  pubkey: string,
  role: string,
  signedBy: string,
): Promise<Uint8Array> {
  const msg = [
    'wevibe.update_member_role.v1',
    `org_id:${orgId}`,
    `pubkey:${pubkey}`,
    `role:${role}`,
    `signed_by:${signedBy}`,
  ].join('\n');
  return new TextEncoder().encode(msg);
}

export async function transferLeadershipCanonical(
  orgId: string,
  newLeaderPubkey: string,
  signedBy: string,
): Promise<Uint8Array> {
  const msg = [
    'wevibe.transfer_leadership.v1',
    `org_id:${orgId}`,
    `new_leader_pubkey:${newLeaderPubkey}`,
    `signed_by:${signedBy}`,
  ].join('\n');
  return new TextEncoder().encode(msg);
}

export async function closeOrgCanonical(
  orgId: string,
  signedBy: string,
): Promise<Uint8Array> {
  const msg = [
    'wevibe.close_org.v1',
    `org_id:${orgId}`,
    `signed_by:${signedBy}`,
  ].join('\n');
  return new TextEncoder().encode(msg);
}

export async function getWalletAddress(): Promise<string> {
  const available = detectWallets();
  if (available.length === 0) {
    throw new Error('No wallet extension detected (install Keplr or Leap).');
  }

  const orderedProviders: WalletProvider[] = [];
  if (available.includes('keplr')) {
    orderedProviders.push('keplr');
  }
  if (available.includes('leap')) {
    orderedProviders.push('leap');
  }

  let lastError: Error | null = null;
  for (const provider of orderedProviders) {
    try {
      const connection = await connectWallet(provider);
      return connection.address;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError ?? new Error('Failed to connect wallet');
}
