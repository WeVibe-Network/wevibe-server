'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Button from '@/components/ui/button';
import Card from '@/components/ui/card';
import { createOrg } from '@/lib/hub-client';
import { useOrgContext } from '@/lib/org-context';
import { getIdentity, getWalletAddress } from '@/lib/wevibe-auth';
import { buildOrgSetup } from '@/lib/wevibe-crypto';

const ONE_ORG_GATE_COPY = 'Only one organization per account is allowed.';
const ONE_ORG_GATE_ERROR = 'You already own an organization. Only one organization per account is allowed.';

interface CreateOrgSuccessState {
  orgId: string;
  orgName: string;
  recoveryPhrase: string;
}

function isLeaderOwnershipConflict(err: unknown): boolean {
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const status = (err as { status?: unknown }).status;
    if (status === 409) {
      return true;
    }
  }

  const message = err instanceof Error ? err.message : String(err);
  const normalized = message.toLowerCase();
  return normalized.includes('409')
    || normalized.includes('already owns')
    || normalized.includes('already own')
    || (normalized.includes('one org') && normalized.includes('account'));
}

export default function CreateOrgPage() {
  const router = useRouter();
  const { orgs, loading: orgsLoading } = useOrgContext();
  const [orgName, setOrgName] = useState('');
  const [domain, setDomain] = useState('');
  const [identityLoaded, setIdentityLoaded] = useState(false);
  const [identity, setIdentity] = useState<Awaited<ReturnType<typeof getIdentity>>>(null);
  const [walletAddr, setWalletAddr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<CreateOrgSuccessState | null>(null);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  const leaderOrg = useMemo(
    () => orgs.find((org) => org.role === 'leader') ?? null,
    [orgs],
  );

  useEffect(() => {
    let cancelled = false;

    void Promise.all([getIdentity(), getWalletAddress()])
      .then(([nextIdentity, nextWallet]) => {
        if (cancelled) {
          return;
        }
        setIdentity(nextIdentity);
        setWalletAddr(nextWallet);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setIdentity(null);
        setWalletAddr(null);
      })
      .finally(() => {
        if (!cancelled) {
          setIdentityLoaded(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSuccess(null);

    if (!identity || !walletAddr) {
      setError('No dashboard identity/wallet found. Log in again before creating an organization.');
      return;
    }

    const orgNameValue = orgName.trim();
    const domainValue = domain.trim();

    if (!orgNameValue) {
      setError('Org Name is required');
      return;
    }
    if (!domainValue) {
      setError('Domain of Expertise is required');
      return;
    }

    setSubmitting(true);

    try {
      const setup = await buildOrgSetup({
        orgName: orgNameValue,
        domain: domainValue,
        leaderEd25519PubHex: identity.pubkeyHex,
        leaderSeedHex: identity.seedHex,
        leaderWallet: walletAddr,
      });
      const created = await createOrg(setup.payload);

      setSuccess({
        orgId: created.org_id,
        orgName: orgNameValue,
        recoveryPhrase: setup.recoveryPhrase,
      });
      setCopyStatus('idle');
    } catch (err) {
      if (isLeaderOwnershipConflict(err)) {
        setError(
          leaderOrg
            ? `You already own an organization: ${leaderOrg.org_name}. ${ONE_ORG_GATE_COPY}`
            : ONE_ORG_GATE_ERROR,
        );
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSubmitting(false);
    }
  }, [domain, identity, leaderOrg, orgName, walletAddr]);

  const handleCopyPhrase = useCallback(async () => {
    if (!success?.recoveryPhrase) {
      return;
    }

    try {
      await navigator.clipboard.writeText(success.recoveryPhrase);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('failed');
    }
  }, [success]);

  const loading = !identityLoaded || orgsLoading;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight text-wv-text">Create Organization</h1>
        <p className="text-sm text-wv-dim">
          Register a real organization through the WeVibe hub. You become the leader for this org.
        </p>
      </header>

      <div className="rounded-lg border border-[rgba(52,220,240,0.4)] bg-[rgba(52,220,240,0.12)] p-4 text-sm text-wv-cyan">
        <p className="font-medium">Real organization setup</p>
        <p className="mt-1 text-wv-cyan">
          This flow creates a real organization with real encryption envelopes, and registers you as leader.
          If your wallet needs gas first, fund it in the{' '}
          <Link href="/faucet" className="font-medium text-wv-violet hover:opacity-90">
            Faucet
          </Link>{' '}
          tab before submitting.
        </p>
      </div>

      {loading && (
        <Card className="p-6">
          <p className="text-sm text-wv-dim">Loading identity and organization status…</p>
        </Card>
      )}

      {!loading && (!identity || !walletAddr) && (
        <Card className="p-6">
          <p className="text-sm text-wv-dim">
            No dashboard identity and wallet are available for organization setup.
          </p>
          <p className="mt-2 text-sm text-wv-dim">
            Log in first so WeVibe can bind the organization leader role to your account.
          </p>
          <Link href="/login" className="mt-4 inline-flex text-sm font-medium text-wv-violet hover:opacity-90">
            Go to login
          </Link>
        </Card>
      )}

      {!loading && identity && walletAddr && success && (
        <Card className="p-6">
          <div className="flex flex-col gap-5">
            <div className="rounded-lg border border-[rgba(54,211,153,0.4)] bg-[rgba(54,211,153,0.12)] p-4">
              <p className="text-sm font-semibold text-wv-green">Organization created successfully</p>
              <p className="mt-2 text-sm text-wv-text">
                Save this recovery phrase now. It is shown ONCE and is the ONLY way to recover your
                organization&apos;s master key. WeVibe cannot recover it for you.
              </p>
              <code className="mt-3 block break-words rounded-md border border-wv-line bg-wv-panel-2 p-3 font-mono text-sm leading-6 text-wv-text">
                {success.recoveryPhrase}
              </code>
              <div className="mt-3 flex items-center gap-3">
                <Button type="button" variant="secondary" onClick={handleCopyPhrase}>
                  Copy
                </Button>
                {copyStatus === 'copied' && <span className="text-xs text-wv-green">Recovery phrase copied.</span>}
                {copyStatus === 'failed' && (
                  <span className="text-xs text-wv-red">Copy failed. Please copy it manually.</span>
                )}
              </div>
            </div>

            <div className="rounded-md border border-wv-line bg-wv-panel-2 p-4">
              <p className="text-xs font-mono uppercase tracking-[0.08em] text-wv-dim">New organization</p>
              <p className="mt-2 text-sm text-wv-text">{success.orgName}</p>
              <p className="mt-1 font-mono text-sm text-wv-text">{success.orgId}</p>
              <Link
                href={`/discover/${success.orgId}`}
                className="mt-3 inline-flex text-sm font-medium text-wv-violet hover:opacity-90"
              >
                View organization details
              </Link>
            </div>

            <div className="flex items-center gap-3">
              <Button type="button" onClick={() => router.push('/')}>
                Continue to dashboard
              </Button>
            </div>
          </div>
        </Card>
      )}

      {!loading && identity && walletAddr && !success && leaderOrg && (
        <Card className="p-6">
          <div className="rounded-lg border border-[rgba(255,178,85,0.4)] bg-[rgba(255,178,85,0.12)] p-4">
            <p className="text-sm font-semibold text-wv-amber">
              You already own an organization: {leaderOrg.org_name}
            </p>
            <p className="mt-2 text-sm text-wv-text">{ONE_ORG_GATE_COPY}</p>
            <Link
              href={`/discover/${leaderOrg.org_id}`}
              className="mt-3 inline-flex text-sm font-medium text-wv-violet hover:opacity-90"
            >
              View organization details
            </Link>
          </div>
        </Card>
      )}

      {!loading && identity && walletAddr && !success && !leaderOrg && (
        <form onSubmit={handleSubmit} data-testid="create-org-form" className="flex flex-col gap-5">
          <Card className="p-6">
            <div className="flex flex-col gap-4">
              <div>
                <label htmlFor="org-name" className="block text-sm font-medium text-wv-text">
                  Org Name
                </label>
                <input
                  id="org-name"
                  data-testid="org-name-input"
                  type="text"
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                  placeholder="My Organization"
                  className="mt-1 w-full rounded-[11px] border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text placeholder:text-wv-faint focus:border-wv-violet focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="domain" className="block text-sm font-medium text-wv-text">
                  Domain of Expertise
                </label>
                <input
                  id="domain"
                  data-testid="domain-input"
                  type="text"
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  placeholder="e.g. React, Next.js, TypeScript"
                  className="mt-1 w-full rounded-[11px] border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text placeholder:text-wv-faint focus:border-wv-violet focus:outline-none"
                />
                <p className="mt-1 text-xs text-wv-dim">
                  What your org specializes in — this is how contributors discover and decide to join you. Be
                  specific about your stack or field.
                </p>
              </div>
            </div>
          </Card>

          {error && (
            <div
              data-testid="error-display"
              className="rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-3 py-2 text-sm text-wv-red"
            >
              {error}
            </div>
          )}

          <div className="flex items-center gap-3">
            <Button type="submit" data-testid="submit-button" disabled={submitting}>
              {submitting ? 'Creating…' : 'Create Organization'}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
