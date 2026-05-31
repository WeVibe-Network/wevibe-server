'use client';

import { FormEvent, useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createOrgCanonical, getWalletAddress, signCanonical } from '@/lib/wevibe-signing';
import { createOrg } from '@/lib/hub-client';
import { buildRegisterOrgMsg, relayOrgDecision } from '@/lib/chain-client';

const FAUCET_URL = process.env.NEXT_PUBLIC_WEVIBE_FAUCET_URL ?? 'http://localhost:4470';
const DEFAULT_STORAGE_QUOTA = 1000;
const DEFAULT_RETRIEVAL_BUDGET = 500;
const DEFAULT_FAUCET_AMOUNT = 1_000_000;

async function fundLeaderWallet(walletAddress: string): Promise<void> {
  const resp = await fetch(`${FAUCET_URL}/v1/fund`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      address: walletAddress,
      amount: DEFAULT_FAUCET_AMOUNT,
    }),
  });

  if (!resp.ok) {
    const payload = await resp.text().catch(() => resp.statusText);
    throw new Error(`Failed funding leader wallet from faucet: ${payload || resp.statusText}`);
  }
}

function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function generateEphemeralEd25519(): Promise<{ publicKey: CryptoKey; privateKey: CryptoKey; pubkeyHex: string }> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify'],
  );
  const rawPubkey = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  const pubkeyHex = bufToHex(rawPubkey);
  return { publicKey: keyPair.publicKey, privateKey: keyPair.privateKey, pubkeyHex };
}

async function generateEphemeralX25519(): Promise<{ publicKey: CryptoKey; privateKey: CryptoKey; pubkeyHex: string }> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  const rawPubkey = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  const pubkeyHex = bufToHex(rawPubkey);
  return { publicKey: keyPair.publicKey, privateKey: keyPair.privateKey, pubkeyHex };
}

export default function CreateOrgPage() {
  const router = useRouter();
  const [orgId, setOrgId] = useState('');
  const [orgName, setOrgName] = useState('');
  const [domain, setDomain] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSuccess(false);

    if (!orgId.trim()) {
      setError('Org ID is required');
      return;
    }
    if (!orgName.trim()) {
      setError('Org Name is required');
      return;
    }
    if (!domain.trim()) {
      setError('Domain is required');
      return;
    }

    setSubmitting(true);

    try {
      const ephemeralEd25519 = await generateEphemeralEd25519();
      const ephemeralX25519 = await generateEphemeralX25519();
      const leaderWallet = await getWalletAddress();
      await fundLeaderWallet(leaderWallet);

      const encEnvelope = 'placeholder-enc-envelope';
      const searchEnvelope = 'placeholder-search-envelope';
      const modEnvelope = 'placeholder-mod-envelope';
      const pkMod = `pkmod-${orgId.trim()}`;

      const canonical = await createOrgCanonical(
        orgId.trim(),
        ephemeralEd25519.pubkeyHex,
        ephemeralX25519.pubkeyHex,
        orgName.trim(),
        domain.trim(),
        encEnvelope,
        searchEnvelope,
        modEnvelope,
        pkMod,
        null,
      );

      const signature = await signCanonical(ephemeralEd25519.privateKey, canonical);

      const createdOrg = await createOrg({
        org_id: orgId.trim(),
        leader_pubkey: ephemeralEd25519.pubkeyHex,
        leader_x25519_pubkey: ephemeralX25519.pubkeyHex,
        leader_wallet: leaderWallet,
        org_name: orgName.trim(),
        domain: domain.trim(),
        enc_envelope: encEnvelope,
        search_envelope: searchEnvelope,
        mod_envelope: modEnvelope,
        pk_mod: pkMod,
        signature,
      });

      const msgRegisterOrg = buildRegisterOrgMsg(
        leaderWallet,
        orgId.trim(),
        createdOrg.leader_pubkey,
        DEFAULT_STORAGE_QUOTA,
        DEFAULT_RETRIEVAL_BUDGET,
        domain.trim(),
        createdOrg.hub_serving_key_address,
        leaderWallet,
      );

      await relayOrgDecision(orgId.trim(), [msgRegisterOrg], `register-org:${orgId.trim()}`);

      setSuccess(true);
      setTimeout(() => {
        router.push('/');
      }, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [orgId, orgName, domain, router]);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Create Organization</h1>
        <p className="text-sm text-zinc-500">
          Register a new organization in the WeVibe Network hub.
        </p>
      </header>

      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        <p className="font-medium">Ephemeral Key Generation</p>
        <p className="mt-1 text-amber-700">
          This form generates temporary keys for testing. Full org setup with real encryption envelopes requires running the wevibe-mcp setup_org tool.
        </p>
      </div>

      <form onSubmit={handleSubmit} data-testid="create-org-form" className="flex flex-col gap-6">
        <div className="rounded-xl border border-zinc-200 bg-white/70 p-6 shadow-sm">
          <div className="flex flex-col gap-4">
            <div>
              <label htmlFor="org-id" className="block text-sm font-medium text-zinc-700">
                Org ID
              </label>
              <input
                id="org-id"
                data-testid="org-id-input"
                type="text"
                value={orgId}
                onChange={e => setOrgId(e.target.value)}
                placeholder="my-org"
                className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
              />
              <p className="mt-1 text-xs text-zinc-500">
                A unique identifier for your organization (lowercase, hyphens allowed).
              </p>
            </div>

            <div>
              <label htmlFor="org-name" className="block text-sm font-medium text-zinc-700">
                Org Name
              </label>
              <input
                id="org-name"
                data-testid="org-name-input"
                type="text"
                value={orgName}
                onChange={e => setOrgName(e.target.value)}
                placeholder="My Organization"
                className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
              />
            </div>

            <div>
              <label htmlFor="domain" className="block text-sm font-medium text-zinc-700">
                Domain
              </label>
              <input
                id="domain"
                data-testid="domain-input"
                type="text"
                value={domain}
                onChange={e => setDomain(e.target.value)}
                placeholder="example.com"
                className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
              />
              <p className="mt-1 text-xs text-zinc-500">
                The domain associated with this organization.
              </p>
            </div>
          </div>
        </div>

        {error && (
          <div data-testid="error-display" className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </div>
        )}

        {success && (
          <div data-testid="success-message" className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            Organization created! Redirecting…
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            data-testid="submit-button"
            disabled={submitting}
            className="inline-flex items-center justify-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:ring-offset-1 disabled:cursor-not-allowed disabled:bg-indigo-300"
          >
            {submitting ? 'Creating…' : 'Create Organization'}
          </button>
        </div>
      </form>
    </div>
  );
}
