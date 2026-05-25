'use client';

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConnectionState, WeVibeMcpClient, getMcpClient, resetMcpClient } from '@/lib/mcp-client';
import { getOrg, getOrgChainConfig, updateOrgConfig, type RepTier } from '@/lib/hub-client';
import { loadSettings, saveSettings, type DashboardSettings } from '@/lib/settings';
import { WalletConnectButton } from '@/components/wallet-connect-button';
import { getChainConfig, connectWallet } from '@/lib/wallet-connect';
import { directBroadcast, type EncodeObject } from '@/lib/chain-client';
import { relayBroadcast } from '@/lib/relay-client';

type OrgInfoResponse =
  | { error: string; identity?: string }
  | {
      org_id: string;
      org_name: string;
      role: string;
      current_epoch: number;
      egress_mode: string;
      identity: string;
      hub_url: string;
      mod_key_available: boolean;
      enc_key_count: number;
      required_approvals?: number;
    };

const stateLabels: Record<ConnectionState, string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting…',
  connected: 'Connected',
  error: 'Error',
};

const stateColors: Record<ConnectionState, string> = {
  disconnected: 'bg-zinc-400',
  connecting: 'bg-amber-400 animate-pulse',
  connected: 'bg-emerald-500',
  error: 'bg-rose-500',
};

export default function SettingsPage() {
  const [url, setUrl] = useState('http://localhost:4450');
  const [state, setState] = useState<ConnectionState>('disconnected');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [orgInfo, setOrgInfo] = useState<OrgInfoResponse | null>(null);
  const listenerRef = useRef<(() => void) | null>(null);
  const [requiredApprovals, setRequiredApprovals] = useState<number>(1);
  const [reportVoteThreshold, setReportVoteThreshold] = useState<number>(1);
  const [configLoading, setConfigLoading] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configSuccess, setConfigSuccess] = useState<string | null>(null);
  const [savingConfig, setSavingConfig] = useState(false);
  const [chainConfigLoading, setChainConfigLoading] = useState(false);
  const [chainConfigError, setChainConfigError] = useState<string | null>(null);
  const [chainConfigSuccess, setChainConfigSuccess] = useState<string | null>(null);
  const [savingChainConfig, setSavingChainConfig] = useState(false);
  const [serveAttestationRequired, setServeAttestationRequired] = useState(false);
  const [repTiers, setRepTiers] = useState<RepTier[]>([]);

  const attachListener = useCallback((client: WeVibeMcpClient) => {
    listenerRef.current?.();
    listenerRef.current = client.addStateListener(setState);
    setState(client.state);
  }, []);

  const updateOrgInfo = useCallback(async (client: WeVibeMcpClient) => {
    try {
      const info = await client.callTool<OrgInfoResponse>('wevibe_org_info');
      setOrgInfo(info);
      if ('error' in info) {
        setError(info.error);
      } else {
        setError(null);
      }
    } catch (err) {
      setOrgInfo(null);
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const savedUrl = window.localStorage.getItem('wevibe-mcp-url') ?? 'http://localhost:4450';
    setUrl(savedUrl);

    const client = getMcpClient();
    attachListener(client);

    let cancelled = false;
    const connectIfNeeded = async () => {
      if (client.state === 'connected') {
        await updateOrgInfo(client);
        return;
      }

      // Only auto-connect from disconnected, not from error state.
      // User must click Connect to recover from errors.
      if (client.state !== 'disconnected') {
        return;
      }

      setLoading(true);
      setError(null);
      try {
        await client.connect();
        if (!cancelled) {
          await updateOrgInfo(client);
        }
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    connectIfNeeded();

    return () => {
      cancelled = true;
      listenerRef.current?.();
      listenerRef.current = null;
    };
  }, [attachListener, updateOrgInfo]);

  const handleConnect = useCallback(async (event?: FormEvent) => {
    event?.preventDefault();
    setLoading(true);
    setError(null);
    setOrgInfo(null);

    const targetUrl = url.trim() || 'http://localhost:4450';

    try {
      const client = resetMcpClient(targetUrl);
      attachListener(client);
      await client.connect();
      await updateOrgInfo(client);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [attachListener, updateOrgInfo, url]);

  const statusBadge = useMemo(() => (
    <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium text-white ${stateColors[state]}`}>
      <span className="h-2 w-2 rounded-full bg-white" />
      {stateLabels[state]}
    </span>
  ), [state]);
  const orgLoaded = useMemo(() => orgInfo !== null && !('error' in orgInfo), [orgInfo]);

  useEffect(() => {
    if (!orgLoaded || !orgInfo || 'error' in orgInfo) {
      return;
    }
    let cancelled = false;
    setConfigLoading(true);
    setConfigError(null);
    void getOrg(orgInfo.org_id)
      .then(summary => {
        if (cancelled) return;
        setRequiredApprovals(summary.required_approvals ?? 1);
        setReportVoteThreshold(summary.report_vote_threshold ?? 1);
      })
      .catch(err => {
        if (cancelled) return;
        setConfigError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) {
          setConfigLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [orgLoaded, orgInfo]);

  useEffect(() => {
    if (!orgLoaded || !orgInfo || 'error' in orgInfo) {
      return;
    }
    let cancelled = false;
    setChainConfigLoading(true);
    setChainConfigError(null);
    void getOrgChainConfig(orgInfo.org_id)
      .then(config => {
        if (cancelled) return;
        setServeAttestationRequired(config.serve_attestation_required);
        setRepTiers(config.rep_tiers ?? []);
      })
      .catch(err => {
        if (cancelled) return;
        setChainConfigError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) {
          setChainConfigLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [orgLoaded, orgInfo]);

  const updateTier = useCallback((index: number, field: keyof RepTier, value: string) => {
    setRepTiers(prev => prev.map((tier, i) => {
      if (i !== index) return tier;
      if (field === 'payout_per_memory') {
        return { ...tier, payout_per_memory: value };
      }
      const asNumber = Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
      if (field === 'min_reputation') {
        return { ...tier, min_reputation: asNumber };
      }
      if (field === 'max_reputation') {
        return { ...tier, max_reputation: asNumber };
      }
      return { ...tier, max_contributions_per_epoch: asNumber };
    }));
  }, []);

  const addTier = useCallback(() => {
    setRepTiers(prev => [...prev, {
      min_reputation: 0,
      max_reputation: 0,
      max_contributions_per_epoch: 1,
      payout_per_memory: '1',
    }]);
  }, []);

  const removeTier = useCallback((index: number) => {
    setRepTiers(prev => prev.filter((_, i) => i !== index));
  }, []);

  const handleConfigSave = useCallback(async () => {
    if (!orgLoaded || !orgInfo || 'error' in orgInfo) {
      return;
    }
    if (requiredApprovals < 1) {
      setConfigError('Required approvals must be at least 1');
      return;
    }
    if (reportVoteThreshold < 1) {
      setConfigError('Report vote threshold must be at least 1');
      return;
    }
    setSavingConfig(true);
    setConfigError(null);
    setConfigSuccess(null);
    try {
      const walletConn = await connectWallet();

      const msgSetOrgConfig: EncodeObject = {
        typeUrl: '/wevibe.org.v1.MsgSetOrgConfig',
        value: Buffer.from(JSON.stringify({
          signer: walletConn.address,
          org_id: orgInfo.org_id,
          serve_attestation_required: false,
          min_contributions_per_epoch: 0,
          contest_stake_vibe: 0,
        })),
      };

      const result = await directBroadcast(walletConn.address, [msgSetOrgConfig]);
      setConfigSuccess(`Moderation settings updated. Tx: ${result.txHash.slice(0, 16)}...`);
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingConfig(false);
    }
  }, [orgLoaded, orgInfo, requiredApprovals, reportVoteThreshold]);

  const handleChainConfigSave = useCallback(async () => {
    if (!orgLoaded || !orgInfo || 'error' in orgInfo) {
      return;
    }
    if (repTiers.length === 0) {
      setChainConfigError('At least one rep tier is required');
      return;
    }

    for (const tier of repTiers) {
      if (!tier.payout_per_memory.trim()) {
        setChainConfigError('Each rep tier requires payout per memory');
        return;
      }
    }

    setSavingChainConfig(true);
    setChainConfigError(null);
    setChainConfigSuccess(null);

    try {
      const walletConn = await connectWallet();

      const msgSetOrgConfig: EncodeObject = {
        typeUrl: '/wevibe.org.v1.MsgSetOrgConfig',
        value: Buffer.from(JSON.stringify({
          signer: walletConn.address,
          org_id: orgInfo.org_id,
          serve_attestation_required: serveAttestationRequired,
          min_contributions_per_epoch: 0,
          contest_stake_vibe: 0,
        })),
      };

      const txHash = await relayBroadcast(orgInfo.org_id, walletConn.address, [msgSetOrgConfig]);
      setChainConfigSuccess(`Chain config updated. Tx: ${txHash.slice(0, 16)}...`);
    } catch (err) {
      setChainConfigError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingChainConfig(false);
    }
  }, [orgLoaded, orgInfo, repTiers, serveAttestationRequired]);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <header className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-3xl font-semibold tracking-tight">Dashboard Settings</h1>
          {statusBadge}
        </div>
        <p className="text-sm text-zinc-500">
          Configure the MCP dashboard connector. Set the server URL, establish a session, and view the active org context.
        </p>
      </header>

      <section className="rounded-xl border border-zinc-200 bg-white/70 p-6 shadow-sm">
        <form onSubmit={handleConnect} className="flex flex-col gap-4">
          <div>
            <label htmlFor="mcp-url" className="block text-sm font-medium text-zinc-700">
              MCP Server URL
            </label>
            <input
              id="mcp-url"
              type="url"
              value={url}
              onChange={event => setUrl(event.target.value)}
              placeholder="http://localhost:4450"
              className="mt-2 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
            />
            <p className="mt-2 text-xs text-zinc-500">
              This should point to the running `wevibe-mcp --dashboard` instance. Use a reachable URL from your browser.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              className="inline-flex items-center justify-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:ring-offset-1"
              disabled={loading}
            >
              {loading ? 'Connecting…' : 'Connect'}
            </button>

            <button
              type="button"
              className="inline-flex items-center justify-center rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-300 focus:ring-offset-1"
              onClick={() => handleConnect()}
              disabled={loading}
            >
              Retry
            </button>

            <button
              type="button"
              className="inline-flex items-center justify-center rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-300 focus:ring-offset-1"
              onClick={() => setOrgInfo(null)}
            >
              Clear Org Info
            </button>
          </div>

          {error && (
            <div className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              {error}
            </div>
          )}
        </form>
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white/70 p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-zinc-900">Current Org Context</h2>
        <p className="mt-1 text-sm text-zinc-500">
          The dashboard requests org details from the MCP server once a connection is established. If fields are missing, reconnect or confirm membership.
        </p>

        <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <InfoCell label="Org Name" value={orgInfo && 'error' in orgInfo ? '—' : orgInfo?.org_name ?? '—'} />
          <InfoCell label="Org ID" value={orgInfo && 'error' in orgInfo ? '—' : orgInfo?.org_id ?? '—'} />
          <InfoCell label="Role" value={orgInfo && 'error' in orgInfo ? '—' : orgInfo?.role ?? '—'} />
          <InfoCell label="Current Epoch" value={orgInfo && 'error' in orgInfo ? '—' : (orgInfo?.current_epoch?.toString() ?? '—')} />
          <InfoCell label="Identity" value={orgInfo?.identity ?? '—'} />
          <InfoCell label="Hub URL" value={orgInfo && 'error' in orgInfo ? '—' : orgInfo?.hub_url ?? '—'} />
          <InfoCell label="Egress Mode" value={orgInfo && 'error' in orgInfo ? '—' : orgInfo?.egress_mode ?? '—'} />
          <InfoCell
            label="Encryption Keys"
            value={orgInfo && 'error' in orgInfo ? '—' : (orgInfo?.enc_key_count?.toString() ?? '—')}
          />
          <InfoCell
            label="Moderation Key"
            value={orgInfo && 'error' in orgInfo ? '—' : (orgInfo?.mod_key_available ? 'Available' : 'Missing')}
          />
          <InfoCell
            label="Required Approvals"
            value={configLoading ? 'Loading…' : requiredApprovals.toString()}
          />
        </dl>

        {orgInfo && 'error' in orgInfo && (
          <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {orgInfo.error}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white/70 p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-zinc-900">Wallet</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Connect your Cosmos wallet to link your on-chain identity with your dashboard identity.
          Your wallet address will be associated with your org membership for reputation tracking.
        </p>
        <div className="mt-4">
          {orgInfo && orgLoaded && 'org_id' in orgInfo ? (
            <WalletConnectButton orgID={orgInfo.org_id} />
          ) : (
            <p className="text-sm text-zinc-500">Connect to an MCP server and org first.</p>
          )}
        </div>
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white/70 p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-zinc-900">Moderation Configuration</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Control how many moderator votes are required before a memory moves to the approval batch.
          Org leaders can always approve immediately.
        </p>

        <div className="mt-3 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
          <span>🔐</span>
          <span>Changes to Required Approvals and Report Vote Threshold require wallet signature.</span>
        </div>

        {configError && (
          <div className="mt-4 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {configError}
          </div>
        )}

        {configSuccess && (
          <div className="mt-4 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            {configSuccess}
          </div>
        )}

        <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="sm:max-w-xs">
            <label htmlFor="required-approvals" className="block text-sm font-medium text-zinc-700">
              Moderator Approvals Required
            </label>
            <input
              id="required-approvals"
              data-testid="required-approvals-input"
              type="number"
              min={1}
              max={10}
              value={requiredApprovals}
              onChange={event => {
                const next = Number(event.target.value);
                if (Number.isNaN(next)) {
                  setRequiredApprovals(1);
                  return;
                }
                setRequiredApprovals(Math.min(10, Math.max(1, next)));
              }}
              disabled={configLoading || savingConfig || !orgLoaded}
              className="mt-2 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:cursor-not-allowed disabled:bg-zinc-100"
            />
            <p className="mt-2 text-xs text-zinc-500">
              Set between 1 and 10. Moderator votes are tracked off-chain in the hub.
            </p>
          </div>

          <div className="sm:max-w-xs">
            <label htmlFor="report-vote-threshold" className="block text-sm font-medium text-zinc-700">
              Report Vote Threshold
            </label>
            <input
              id="report-vote-threshold"
              data-testid="report-vote-threshold-input"
              type="number"
              min={1}
              max={10}
              value={reportVoteThreshold}
              onChange={event => {
                const next = Number(event.target.value);
                if (Number.isNaN(next)) {
                  setReportVoteThreshold(1);
                  return;
                }
                setReportVoteThreshold(Math.min(10, Math.max(1, next)));
              }}
              disabled={configLoading || savingConfig || !orgLoaded}
              className="mt-2 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:cursor-not-allowed disabled:bg-zinc-100"
            />
            <p className="mt-2 text-xs text-zinc-500">
              Votes needed to uphold or dismiss a report.
            </p>
          </div>

          <button
            type="button"
            className="inline-flex items-center justify-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:ring-offset-1 disabled:cursor-not-allowed disabled:bg-indigo-300"
            onClick={handleConfigSave}
            disabled={configLoading || savingConfig || !orgLoaded}
          >
            {savingConfig ? 'Saving…' : 'Save' }
          </button>
        </div>

        {configLoading && (
          <p className="mt-4 text-xs text-zinc-500">Loading current moderation settings…</p>
        )}
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white/70 p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-zinc-900">Chain Configuration</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Manage on-chain org settings via hub relay and transaction broadcast.
        </p>

        {chainConfigError && (
          <div className="mt-4 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {chainConfigError}
          </div>
        )}

        {chainConfigSuccess && (
          <div className="mt-4 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 break-all">
            {chainConfigSuccess}
          </div>
        )}

        <div className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50/60 p-4">
          <label className="inline-flex items-center gap-2 text-sm text-zinc-700">
            <input
              type="checkbox"
              checked={serveAttestationRequired}
              onChange={event => setServeAttestationRequired(event.target.checked)}
              disabled={chainConfigLoading || savingChainConfig || !orgLoaded}
              className="h-4 w-4 rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500"
            />
            Require serve attestations
          </label>
        </div>

        <div className="mt-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zinc-800">Reputation Tiers</h3>
            <button
              type="button"
              onClick={addTier}
              disabled={chainConfigLoading || savingChainConfig || !orgLoaded}
              className="inline-flex items-center rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Add Tier
            </button>
          </div>

          {repTiers.map((tier, idx) => (
            <div key={idx} className="rounded-lg border border-zinc-200 bg-white p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-medium text-zinc-600">Tier {idx + 1}</span>
                <button
                  type="button"
                  onClick={() => removeTier(idx)}
                  disabled={repTiers.length === 1 || chainConfigLoading || savingChainConfig || !orgLoaded}
                  className="text-xs text-rose-600 hover:text-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Remove
                </button>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <label className="text-xs text-zinc-600">
                  Min Reputation
                  <input
                    type="number"
                    min={0}
                    value={tier.min_reputation}
                    onChange={event => updateTier(idx, 'min_reputation', event.target.value)}
                    disabled={chainConfigLoading || savingChainConfig || !orgLoaded}
                    className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm"
                  />
                </label>
                <label className="text-xs text-zinc-600">
                  Max Reputation
                  <input
                    type="number"
                    min={0}
                    value={tier.max_reputation}
                    onChange={event => updateTier(idx, 'max_reputation', event.target.value)}
                    disabled={chainConfigLoading || savingChainConfig || !orgLoaded}
                    className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm"
                  />
                </label>
                <label className="text-xs text-zinc-600">
                  Max Contributions / Epoch
                  <input
                    type="number"
                    min={0}
                    value={tier.max_contributions_per_epoch}
                    onChange={event => updateTier(idx, 'max_contributions_per_epoch', event.target.value)}
                    disabled={chainConfigLoading || savingChainConfig || !orgLoaded}
                    className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm"
                  />
                </label>
                <label className="text-xs text-zinc-600">
                  Payout / Memory
                  <input
                    type="text"
                    value={tier.payout_per_memory}
                    onChange={event => updateTier(idx, 'payout_per_memory', event.target.value)}
                    disabled={chainConfigLoading || savingChainConfig || !orgLoaded}
                    className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm"
                  />
                </label>
              </div>
            </div>
          ))}

          {repTiers.length === 0 && (
            <p className="text-xs text-zinc-500">No rep tiers returned from chain.</p>
          )}
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={handleChainConfigSave}
            disabled={chainConfigLoading || savingChainConfig || !orgLoaded}
            className="inline-flex items-center justify-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-indigo-300"
          >
            {savingChainConfig ? 'Broadcasting…' : 'Save Chain Config'}
          </button>
          {chainConfigLoading && <span className="text-xs text-zinc-500">Loading chain config…</span>}
        </div>
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white/70 p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-zinc-900">Org & LLM Configuration</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Configure your organization ID, moderator pubkey, and LLM provider for memory extraction.
        </p>

        <OrgLlamaConfig />
      </section>
    </div>
  );
}

function InfoCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-100 bg-zinc-50/60 px-4 py-3">
      <dt className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{label}</dt>
      <dd className="mt-1 text-sm font-medium text-zinc-900 break-all">{value}</dd>
    </div>
  );
}

function OrgLlamaConfig() {
  const [settings, setSettings] = useState<DashboardSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then(data => {
        const s = {
          llm_provider: data.llm_provider ?? 'ollama',
          ollama_url: data.ollama_url ?? 'http://localhost:11434',
          ollama_model: data.ollama_model ?? 'qwen2.5:14b',
          openrouter_api_key: data.openrouter_api_key ?? '',
          openrouter_model: data.openrouter_model ?? 'anthropic/claude-sonnet-4',
          org_id: data.org_id ?? '',
          mod_pubkey: data.mod_pubkey ?? '',
        } as DashboardSettings;
        setSettings(s);
      })
      .catch(() => {});
  }, []);

  const handleSave = useCallback(async () => {
    if (!settings) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const resp = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      if (resp.ok) {
        setSaveMsg({ type: 'success', text: 'Settings saved.' });
      } else {
        setSaveMsg({ type: 'error', text: 'Failed to save.' });
      }
    } catch {
      setSaveMsg({ type: 'error', text: 'Network error.' });
    } finally {
      setSaving(false);
    }
  }, [settings]);

  if (!settings) {
    return <p className="mt-4 text-xs text-zinc-500">Loading settings…</p>;
  }

  return (
    <div className="mt-4 space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="org-id" className="block text-sm font-medium text-zinc-700">
            Org ID
          </label>
          <input
            id="org-id"
            type="text"
            value={settings.org_id}
            onChange={e => setSettings(s => s ? { ...s, org_id: e.target.value } : s)}
            placeholder="my-org"
            className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
          />
        </div>
        <div>
          <label htmlFor="mod-pubkey" className="block text-sm font-medium text-zinc-700">
            Mod Pubkey (X25519 hex)
          </label>
          <input
            id="mod-pubkey"
            type="text"
            value={settings.mod_pubkey}
            onChange={e => setSettings(s => s ? { ...s, mod_pubkey: e.target.value } : s)}
            placeholder="a1b2c3..."
            className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 font-mono"
          />
        </div>
      </div>

      <div>
        <label htmlFor="llm-provider" className="block text-sm font-medium text-zinc-700">
          LLM Provider
        </label>
        <select
          id="llm-provider"
          value={settings.llm_provider}
          onChange={e => setSettings(s => s ? { ...s, llm_provider: e.target.value as 'ollama' | 'openrouter' } : s)}
          className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
        >
          <option value="ollama">Ollama</option>
          <option value="openrouter">OpenRouter</option>
        </select>
      </div>

      {settings.llm_provider === 'ollama' && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="ollama-url" className="block text-sm font-medium text-zinc-700">
              Ollama URL
            </label>
            <input
              id="ollama-url"
              type="url"
              value={settings.ollama_url}
              onChange={e => setSettings(s => s ? { ...s, ollama_url: e.target.value } : s)}
              placeholder="http://localhost:11434"
              className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
            />
          </div>
          <div>
            <label htmlFor="ollama-model" className="block text-sm font-medium text-zinc-700">
              Ollama Model
            </label>
            <input
              id="ollama-model"
              type="text"
              value={settings.ollama_model}
              onChange={e => setSettings(s => s ? { ...s, ollama_model: e.target.value } : s)}
              placeholder="qwen2.5:14b"
              className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
            />
          </div>
        </div>
      )}

      {settings.llm_provider === 'openrouter' && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="openrouter-api-key" className="block text-sm font-medium text-zinc-700">
              OpenRouter API Key
            </label>
            <input
              id="openrouter-api-key"
              type="password"
              value={settings.openrouter_api_key}
              onChange={e => setSettings(s => s ? { ...s, openrouter_api_key: e.target.value } : s)}
              placeholder="sk-..."
              className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
            />
          </div>
          <div>
            <label htmlFor="openrouter-model" className="block text-sm font-medium text-zinc-700">
              OpenRouter Model
            </label>
            <input
              id="openrouter-model"
              type="text"
              value={settings.openrouter_model}
              onChange={e => setSettings(s => s ? { ...s, openrouter_model: e.target.value } : s)}
              placeholder="anthropic/claude-sonnet-4"
              className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
            />
          </div>
        </div>
      )}

      {saveMsg && (
        <div className={`rounded-lg border px-3 py-2 text-sm ${saveMsg.type === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-rose-200 bg-rose-50 text-rose-700'}`}>
          {saveMsg.text}
        </div>
      )}

      <button
        type="button"
        onClick={handleSave}
        disabled={saving}
        className="inline-flex items-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-indigo-300"
      >
        {saving ? 'Saving…' : 'Save Settings'}
      </button>
    </div>
  );
}
