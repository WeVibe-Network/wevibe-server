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
}

async function parseErrorBody(response: Response): Promise<ErrorBody> {
  return (await response.json().catch(() => ({}))) as ErrorBody;
}

export async function requestOrgCryptoSetup(args: {
  orgName: string;
  domain: string;
  leaderWallet: string;
}): Promise<OrgCryptoSetupResult> {
  const response = await fetch('/api/org-setup', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      org_name: args.orgName,
      domain: args.domain,
      leader_wallet: args.leaderWallet,
    }),
  });

  if (!response.ok) {
    const body = await parseErrorBody(response);
    throw new Error(body.error ?? 'org crypto setup failed');
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
    throw new Error(body.error ?? 'org setup finalize failed');
  }
}

export async function requestProvisionRecall(orgId: string): Promise<void> {
  const response = await fetch('/api/provision-recall', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      org_id: orgId,
    }),
  });

  if (!response.ok) {
    const body = await parseErrorBody(response);
    throw new Error(body.error ?? 'provision recall failed');
  }
}
