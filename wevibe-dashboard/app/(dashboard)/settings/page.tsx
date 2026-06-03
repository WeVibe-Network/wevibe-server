'use client';

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConnectionState, WeVibeMcpClient, getMcpClient, resetMcpClient } from '@/lib/mcp-client';
import { getHubServingAddress, getOrg, getOrgChainConfig } from '@/lib/hub-client';
import { type DashboardSettings } from '@/lib/settings';
import { WalletConnectButton } from '@/components/wallet-connect-button';
import { connectWallet } from '@/lib/wallet-connect';
import { buildSetOrgConfigMsg, buildSetServingKeyMsg, directBroadcast } from '@/lib/chain-client';
import { getConfig } from '@/lib/config';
import { useOrgContext } from '@/lib/org-context';

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
  disconnected: 'bg-wv-panel-3',
  connecting: 'bg-wv-amber animate-pulse',
  connected: 'bg-wv-green',
  error: 'bg-wv-red',
};

export default function SettingsPage() {
  const { activeOrg } = useOrgContext();
  const [url, setUrl] = useState(getConfig().mcpUrl);
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
  const [hubServingAddress, setHubServingAddress] = useState('');
  const [showServingKeyEditor, setShowServingKeyEditor] = useState(false);
  const [newServingKey, setNewServingKey] = useState('');
  const [hubInfraError, setHubInfraError] = useState<string | null>(null);
  const [hubInfraSuccess, setHubInfraSuccess] = useState<string | null>(null);
  const [savingServingKey, setSavingServingKey] = useState(false);

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

    const savedUrl = window.localStorage.getItem('wevibe-mcp-url') ?? getConfig().mcpUrl;
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

    const targetUrl = url.trim() || getConfig().mcpUrl;

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
      <span className="h-2 w-2 rounded-full bg-wv-text" />
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
    void Promise.all([getOrg(orgInfo.org_id), getHubServingAddress()])
      .then(([summary, fallbackServingAddress]) => {
        if (cancelled) return;
        setRequiredApprovals(summary.required_approvals ?? 1);
        setReportVoteThreshold(summary.report_vote_threshold ?? 1);

        const activeOrgServingAddress = (activeOrg as unknown as Record<string, unknown> | null)?.hub_serving_address;
        const summaryServingAddress = summary.hub_serving_address ?? summary.hub_serving_key_address;
        const resolvedServingAddress = [
          typeof summaryServingAddress === 'string' ? summaryServingAddress : '',
          typeof activeOrgServingAddress === 'string' ? activeOrgServingAddress : '',
          fallbackServingAddress,
        ].find((value) => value.trim().length > 0) ?? '';
        setHubServingAddress(resolvedServingAddress);
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
  }, [activeOrg, orgLoaded, orgInfo]);

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
      const msgSetOrgConfig = buildSetOrgConfigMsg(
        walletConn.address,
        orgInfo.org_id,
        false,
        0,
        0,
      );

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

    setSavingChainConfig(true);
    setChainConfigError(null);
    setChainConfigSuccess(null);

    try {
      const walletConn = await connectWallet();
      const msgSetOrgConfig = buildSetOrgConfigMsg(
        walletConn.address,
        orgInfo.org_id,
        serveAttestationRequired,
        0,
        0,
      );

      const result = await directBroadcast(walletConn.address, [msgSetOrgConfig]);
      setChainConfigSuccess(`Chain config updated. Tx: ${result.txHash.slice(0, 16)}...`);
    } catch (err) {
      setChainConfigError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingChainConfig(false);
    }
  }, [orgLoaded, orgInfo, serveAttestationRequired]);

  const handleServingKeySave = useCallback(async () => {
    if (!orgLoaded || !orgInfo || 'error' in orgInfo) {
      return;
    }

    const nextServingKey = newServingKey.trim();
    if (!nextServingKey) {
      setHubInfraError('New serving key address is required.');
      return;
    }

    setSavingServingKey(true);
    setHubInfraError(null);
    setHubInfraSuccess(null);

    try {
      const walletConn = await connectWallet();
      const msgSetServingKey = buildSetServingKeyMsg(
        walletConn.address,
        orgInfo.org_id,
        nextServingKey,
      );

      const result = await directBroadcast(walletConn.address, [msgSetServingKey]);
      setHubServingAddress(nextServingKey);
      setShowServingKeyEditor(false);
      setNewServingKey('');
      setHubInfraSuccess(`Serving key updated. Tx: ${result.txHash.slice(0, 16)}...`);
    } catch (err) {
      setHubInfraError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingServingKey(false);
    }
  }, [newServingKey, orgLoaded, orgInfo]);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <header className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-3xl font-semibold tracking-tight">Dashboard Settings</h1>
          {statusBadge}
        </div>
        <p className="text-sm text-wv-dim">
          Configure the MCP dashboard connector. Set the server URL, establish a session, and view the active org context.
        </p>
      </header>

      <section className="rounded-xl border border-wv-line bg-wv-panel p-6 shadow-wv-sm">
        <form onSubmit={handleConnect} className="flex flex-col gap-4">
          <div>
            <label htmlFor="mcp-url" className="block text-sm font-medium text-wv-text">
              MCP Server URL
            </label>
            <input
              id="mcp-url"
              type="url"
              value={url}
              onChange={event => setUrl(event.target.value)}
              placeholder="http://localhost:4451"
              className="mt-2 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)]"
            />
            <p className="mt-2 text-xs text-wv-dim">
              This should point to the running `wevibe-mcp --dashboard` instance. Use a reachable URL from your browser.
            </p>
            <div className="mt-3 rounded-lg border border-wv-line bg-wv-panel-2 px-3 py-3">
              <p className="text-xs text-wv-dim">
                Moderation runs from a server on YOUR machine (it holds your moderation key). Start it before connecting.
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-wv-dim">
                <li>
                  Run <code className="rounded bg-wv-panel px-1.5 py-0.5 font-mono text-wv-text">{'cd wevibe-mcp && npm run dashboard'}</code> (it listens on http://localhost:4451 by default).
                </li>
                <li>Then enter http://localhost:4451 above and click Connect.</li>
              </ul>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              className="inline-flex items-center justify-center rounded-lg bg-wv-grad-btn px-4 py-2 text-sm font-medium text-white shadow-wv-sm transition hover:opacity-95 focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.35)] focus:ring-offset-1"
              disabled={loading}
            >
              {loading ? 'Connecting…' : 'Connect'}
            </button>

            <button
              type="button"
              className="inline-flex items-center justify-center rounded-lg border border-wv-line-2 px-4 py-2 text-sm font-medium text-wv-text transition hover:bg-wv-line focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.28)] focus:ring-offset-1"
              onClick={() => handleConnect()}
              disabled={loading}
            >
              Retry
            </button>

            <button
              type="button"
              className="inline-flex items-center justify-center rounded-lg border border-wv-line-2 px-4 py-2 text-sm font-medium text-wv-text transition hover:bg-wv-line focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.28)] focus:ring-offset-1"
              onClick={() => setOrgInfo(null)}
            >
              Clear Org Info
            </button>
          </div>

          {error && (
            <div className="rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-3 py-2 text-sm text-wv-red">
              {error}
            </div>
          )}
        </form>
      </section>

      <section className="rounded-xl border border-wv-line bg-wv-panel p-6 shadow-wv-sm">
        <h2 className="text-lg font-semibold text-wv-text">Current Org Context</h2>
        <p className="mt-1 text-sm text-wv-dim">
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
          <div className="mt-4 rounded-lg border border-[rgba(255,178,85,0.4)] bg-[rgba(255,178,85,0.12)] px-3 py-2 text-sm text-wv-amber">
            {orgInfo.error}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-wv-line bg-wv-panel p-6 shadow-wv-sm">
        <h2 className="text-lg font-semibold text-wv-text">Wallet</h2>
        <p className="mt-1 text-sm text-wv-dim">
          Connect your Cosmos wallet to link your on-chain identity with your dashboard identity.
          Your wallet address will be associated with your org membership for reputation tracking.
        </p>
        <div className="mt-4">
          {orgInfo && orgLoaded && 'org_id' in orgInfo ? (
            <WalletConnectButton orgID={orgInfo.org_id} />
          ) : (
            <p className="text-sm text-wv-dim">Connect to an MCP server and org first.</p>
          )}
        </div>
      </section>

      <section className="rounded-xl border border-wv-line bg-wv-panel p-6 shadow-wv-sm">
        <h2 className="text-lg font-semibold text-wv-text">Moderation Configuration</h2>
        <p className="mt-1 text-sm text-wv-dim">
          Control how many moderator votes are required before a memory moves to the approval batch.
          Org leaders can always approve immediately.
        </p>

        <div className="mt-3 flex items-center gap-2 rounded-lg border border-[rgba(255,178,85,0.4)] bg-[rgba(255,178,85,0.12)] px-3 py-2 text-sm text-wv-amber">
          <span>🔐</span>
          <span>Changes to Required Approvals and Report Vote Threshold require wallet signature.</span>
        </div>

        {configError && (
          <div className="mt-4 rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-3 py-2 text-sm text-wv-red">
            {configError}
          </div>
        )}

        {configSuccess && (
          <div className="mt-4 rounded-lg border border-[rgba(54,211,153,0.4)] bg-[rgba(54,211,153,0.12)] px-3 py-2 text-sm text-wv-green">
            {configSuccess}
          </div>
        )}

        <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="sm:max-w-xs">
            <label htmlFor="required-approvals" className="block text-sm font-medium text-wv-text">
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
              className="mt-2 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)] disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
            />
            <p className="mt-2 text-xs text-wv-dim">
              Set between 1 and 10. Moderator votes are tracked off-chain in the hub.
            </p>
          </div>

          <div className="sm:max-w-xs">
            <label htmlFor="report-vote-threshold" className="block text-sm font-medium text-wv-text">
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
              className="mt-2 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)] disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
            />
            <p className="mt-2 text-xs text-wv-dim">
              Votes needed to uphold or dismiss a report.
            </p>
          </div>

          <button
            type="button"
            className="inline-flex items-center justify-center rounded-lg bg-wv-grad-btn px-4 py-2 text-sm font-medium text-white shadow-wv-sm transition hover:opacity-95 focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.35)] focus:ring-offset-1 disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
            onClick={handleConfigSave}
            disabled={configLoading || savingConfig || !orgLoaded}
          >
            {savingConfig ? 'Saving…' : 'Save' }
          </button>
        </div>

        {configLoading && (
          <p className="mt-4 text-xs text-wv-dim">Loading current moderation settings…</p>
        )}
      </section>

      <section className="rounded-xl border border-wv-line bg-wv-panel p-6 shadow-wv-sm">
        <h2 className="text-lg font-semibold text-wv-text">Chain Configuration</h2>
        <p className="mt-1 text-sm text-wv-dim">
          Manage on-chain org settings via direct wallet-signed transaction broadcast.
        </p>

        {chainConfigError && (
          <div className="mt-4 rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-3 py-2 text-sm text-wv-red">
            {chainConfigError}
          </div>
        )}

        {chainConfigSuccess && (
          <div className="mt-4 rounded-lg border border-[rgba(54,211,153,0.4)] bg-[rgba(54,211,153,0.12)] px-3 py-2 text-sm text-wv-green break-all">
            {chainConfigSuccess}
          </div>
        )}

        <div className="mt-4 rounded-lg border border-wv-line bg-wv-panel-2 p-4">
          <label className="inline-flex items-center gap-2 text-sm text-wv-text">
            <input
              type="checkbox"
              checked={serveAttestationRequired}
              onChange={event => setServeAttestationRequired(event.target.checked)}
              disabled={chainConfigLoading || savingChainConfig || !orgLoaded}
              className="h-4 w-4 rounded border-wv-line-2 bg-wv-panel-2 text-wv-violet focus:ring-2 focus:ring-[rgba(124,92,255,0.35)]"
            />
            Require serve attestations
          </label>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={handleChainConfigSave}
            disabled={chainConfigLoading || savingChainConfig || !orgLoaded}
            className="inline-flex items-center justify-center rounded-lg bg-wv-grad-btn px-4 py-2 text-sm font-medium text-white shadow-wv-sm transition hover:opacity-95 disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
          >
            {savingChainConfig ? 'Broadcasting…' : 'Save Chain Config'}
          </button>
          {chainConfigLoading && <span className="text-xs text-wv-dim">Loading chain config…</span>}
        </div>
      </section>

      {orgLoaded && orgInfo && !('error' in orgInfo) && orgInfo.role === 'leader' && (
        <section className="rounded-xl border border-wv-line bg-wv-panel p-6 shadow-wv-sm">
          <h2 className="text-lg font-semibold text-wv-text">Hub Infrastructure</h2>
          <p className="mt-1 text-sm text-wv-dim">
            Control the serving key address used for on-chain serve/denial submissions.
          </p>

          <div className="mt-4 rounded-lg border border-wv-line bg-wv-panel-2 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-wv-dim">Current HubServingAddress</p>
            <p className="mt-1 break-all font-mono text-sm text-wv-text">{hubServingAddress || '—'}</p>
          </div>

          {hubInfraError && (
            <div className="mt-4 rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-3 py-2 text-sm text-wv-red">
              {hubInfraError}
            </div>
          )}

          {hubInfraSuccess && (
            <div className="mt-4 rounded-lg border border-[rgba(54,211,153,0.4)] bg-[rgba(54,211,153,0.12)] px-3 py-2 text-sm text-wv-green break-all">
              {hubInfraSuccess}
            </div>
          )}

          <div className="mt-4">
            {!showServingKeyEditor ? (
              <button
                type="button"
                onClick={() => {
                  setHubInfraError(null);
                  setHubInfraSuccess(null);
                  setNewServingKey(hubServingAddress);
                  setShowServingKeyEditor(true);
                }}
                className="inline-flex items-center justify-center rounded-lg border border-wv-line-2 px-4 py-2 text-sm font-medium text-wv-text transition hover:border-[rgba(124,92,255,0.35)] hover:text-wv-violet"
              >
                Change serving key (self-host)
              </button>
            ) : (
              <div className="rounded-lg border border-[rgba(124,92,255,0.28)] bg-[rgba(124,92,255,0.08)] p-4">
                <label htmlFor="new-serving-key" className="block text-sm font-medium text-wv-text">
                  New serving key address
                </label>
                <input
                  id="new-serving-key"
                  type="text"
                  value={newServingKey}
                  onChange={(event) => setNewServingKey(event.target.value)}
                  placeholder="wevibe1..."
                  disabled={savingServingKey}
                  className="mt-2 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 font-mono text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)] disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
                />
                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleServingKeySave}
                    disabled={savingServingKey || !orgLoaded}
                    className="inline-flex items-center justify-center rounded-lg bg-wv-grad-btn px-4 py-2 text-sm font-medium text-white shadow-wv-sm transition hover:opacity-95 disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
                  >
                    {savingServingKey ? 'Broadcasting…' : 'Broadcast MsgSetServingKey'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowServingKeyEditor(false);
                      setNewServingKey('');
                      setHubInfraError(null);
                    }}
                    disabled={savingServingKey}
                    className="inline-flex items-center justify-center rounded-lg border border-wv-line-2 px-4 py-2 text-sm font-medium text-wv-text transition hover:border-[rgba(124,92,255,0.35)] hover:text-wv-violet disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      <section className="rounded-xl border border-wv-line bg-wv-panel p-6 shadow-wv-sm">
        <h2 className="text-lg font-semibold text-wv-text">Org & LLM Configuration</h2>
        <p className="mt-1 text-sm text-wv-dim">
          Configure your organization ID, moderator pubkey, and LLM provider for memory extraction.
        </p>

        <OrgLlamaConfig />
      </section>
    </div>
  );
}

function InfoCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-wv-line bg-wv-panel-2 px-4 py-3">
      <dt className="text-xs font-semibold uppercase tracking-wide text-wv-dim">{label}</dt>
      <dd className="mt-1 text-sm font-medium text-wv-text break-all">{value}</dd>
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
    return <p className="mt-4 text-xs text-wv-dim">Loading settings…</p>;
  }

  return (
    <div className="mt-4 space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="org-id" className="block text-sm font-medium text-wv-text">
            Org ID
          </label>
          <input
            id="org-id"
            type="text"
            value={settings.org_id}
            onChange={e => setSettings(s => s ? { ...s, org_id: e.target.value } : s)}
            placeholder="my-org"
            className="mt-1 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)]"
          />
        </div>
        <div>
          <label htmlFor="mod-pubkey" className="block text-sm font-medium text-wv-text">
            Mod Pubkey (X25519 hex)
          </label>
          <input
            id="mod-pubkey"
            type="text"
            value={settings.mod_pubkey}
            onChange={e => setSettings(s => s ? { ...s, mod_pubkey: e.target.value } : s)}
            placeholder="a1b2c3..."
            className="mt-1 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)] font-mono"
          />
        </div>
      </div>

      <div>
        <label htmlFor="llm-provider" className="block text-sm font-medium text-wv-text">
          LLM Provider
        </label>
        <select
          id="llm-provider"
          value={settings.llm_provider}
          onChange={e => setSettings(s => s ? { ...s, llm_provider: e.target.value as 'ollama' | 'openrouter' } : s)}
          className="mt-1 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)]"
        >
          <option value="ollama">Ollama</option>
          <option value="openrouter">OpenRouter</option>
        </select>
      </div>

      {settings.llm_provider === 'ollama' && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="ollama-url" className="block text-sm font-medium text-wv-text">
              Ollama URL
            </label>
            <input
              id="ollama-url"
              type="url"
              value={settings.ollama_url}
              onChange={e => setSettings(s => s ? { ...s, ollama_url: e.target.value } : s)}
              placeholder="http://localhost:11434"
              className="mt-1 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)]"
            />
          </div>
          <div>
            <label htmlFor="ollama-model" className="block text-sm font-medium text-wv-text">
              Ollama Model
            </label>
            <input
              id="ollama-model"
              type="text"
              value={settings.ollama_model}
              onChange={e => setSettings(s => s ? { ...s, ollama_model: e.target.value } : s)}
              placeholder="qwen2.5:14b"
              className="mt-1 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)]"
            />
          </div>
        </div>
      )}

      {settings.llm_provider === 'openrouter' && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="openrouter-api-key" className="block text-sm font-medium text-wv-text">
              OpenRouter API Key
            </label>
            <input
              id="openrouter-api-key"
              type="password"
              value={settings.openrouter_api_key}
              onChange={e => setSettings(s => s ? { ...s, openrouter_api_key: e.target.value } : s)}
              placeholder="sk-..."
              className="mt-1 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)]"
            />
          </div>
          <div>
            <label htmlFor="openrouter-model" className="block text-sm font-medium text-wv-text">
              OpenRouter Model
            </label>
            <input
              id="openrouter-model"
              type="text"
              value={settings.openrouter_model}
              onChange={e => setSettings(s => s ? { ...s, openrouter_model: e.target.value } : s)}
              placeholder="anthropic/claude-sonnet-4"
              className="mt-1 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)]"
            />
          </div>
        </div>
      )}

      {saveMsg && (
        <div className={`rounded-lg border px-3 py-2 text-sm ${saveMsg.type === 'success' ? 'border-[rgba(54,211,153,0.4)] bg-[rgba(54,211,153,0.12)] text-wv-green' : 'border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] text-wv-red'}`}>
          {saveMsg.text}
        </div>
      )}

      <button
        type="button"
        onClick={handleSave}
        disabled={saving}
        className="inline-flex items-center rounded-lg bg-wv-grad-btn px-4 py-2 text-sm font-medium text-white shadow-wv-sm transition hover:opacity-95 disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
      >
        {saving ? 'Saving…' : 'Save Settings'}
      </button>
    </div>
  );
}
