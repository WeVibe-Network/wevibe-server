import { bytesToHex, deriveIdentityX25519Keypair, getIdentity, signWithIdentity } from './wevibe-auth';

export interface OrgCryptoSetupPayload {
  leader_pubkey: string;
  leader_x25519_pubkey: string;
  leader_wallet: string;
  org_name: string;
  domain: string;
  fee_model: null;
  pk_mod: string;
  umbral_pk: string;
  signature: string;
  enc_envelope: string;
  search_envelope: string;
  mod_envelope: string;
}

export interface OrgCryptoSetupResult {
  setup_id: string;
  payload: OrgCryptoSetupPayload;
  recovery_phrase: string;
}

interface ErrorBody {
  error?: string;
  code?: string;
  remediation?: string;
}

export class OrgBridgeError extends Error {
  readonly code?: string;
  readonly remediation?: string;
  readonly status: number;

  constructor(message: string, opts: { code?: string; remediation?: string; status: number }) {
    super(message);
    this.name = 'OrgBridgeError';
    this.code = opts.code;
    this.remediation = opts.remediation;
    this.status = opts.status;
  }
}

async function parseErrorBody(response: Response): Promise<ErrorBody> {
  return (await response.json().catch(() => ({}))) as ErrorBody;
}

async function buildRequesterAssertion(): Promise<{
  requesterPubkey: string;
  requesterX25519Pubkey: string;
}> {
  const identity = await getIdentity();
  if (!identity) {
    throw new OrgBridgeError('identity not unlocked', {
      code: 'identity_not_unlocked',
      remediation: 'Unlock or adopt your WeVibe dashboard identity before this operation.',
      status: 401,
    });
  }

  const x25519 = await deriveIdentityX25519Keypair();
  return {
    requesterPubkey: identity.pubkeyHex,
    requesterX25519Pubkey: bytesToHex(x25519.pub),
  };
}

export async function requestOrgCryptoSetup(args: {
  orgName: string;
  domain: string;
  leaderWallet: string;
}): Promise<OrgCryptoSetupResult> {
  const orgName = args.orgName.trim();
  const domain = args.domain.trim();
  const leaderWallet = args.leaderWallet.trim();

  const assertion = await buildRequesterAssertion();
  const canonical = [
    'wevibe.org_setup.v1',
    domain,
    leaderWallet,
    orgName,
    assertion.requesterPubkey,
    assertion.requesterX25519Pubkey,
  ].join('\n');
  const signature = await signWithIdentity(new TextEncoder().encode(canonical));

  const response = await fetch('/api/org-setup', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      org_name: orgName,
      domain,
      leader_wallet: leaderWallet,
      requester_pubkey: assertion.requesterPubkey,
      requester_x25519_pubkey: assertion.requesterX25519Pubkey,
      signature,
    }),
  });

  if (!response.ok) {
    const body = await parseErrorBody(response);
    throw new OrgBridgeError(body.error ?? 'org crypto setup failed', {
      code: body.code,
      remediation: body.remediation,
      status: response.status,
    });
  }

  const body = (await response.json()) as {
    setup_id: string;
    payload: OrgCryptoSetupPayload;
    recovery_phrase: string;
  };

  return {
    setup_id: body.setup_id,
    payload: body.payload,
    recovery_phrase: body.recovery_phrase,
  };
}

export async function finalizeOrgSetup(setupId: string, orgId: string): Promise<void> {
  const response = await fetch('/api/org-setup/finalize', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      setup_id: setupId,
      org_id: orgId,
    }),
  });

  if (!response.ok) {
    const body = await parseErrorBody(response);
    throw new OrgBridgeError(body.error ?? 'org setup finalize failed', {
      code: body.code,
      remediation: body.remediation,
      status: response.status,
    });
  }
}

export async function requestProvisionRecall(orgId: string): Promise<void> {
  const trimmedOrgId = orgId.trim();

  const assertion = await buildRequesterAssertion();
  const canonical = [
    'wevibe.provision_recall.v1',
    trimmedOrgId,
    assertion.requesterPubkey,
    assertion.requesterX25519Pubkey,
  ].join('\n');
  const signature = await signWithIdentity(new TextEncoder().encode(canonical));

  const response = await fetch('/api/provision-recall', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      org_id: trimmedOrgId,
      requester_pubkey: assertion.requesterPubkey,
      requester_x25519_pubkey: assertion.requesterX25519Pubkey,
      signature,
    }),
  });

  if (!response.ok) {
    const body = await parseErrorBody(response);
    throw new OrgBridgeError(body.error ?? 'provision recall failed', {
      code: body.code,
      remediation: body.remediation,
      status: response.status,
    });
  }
}
