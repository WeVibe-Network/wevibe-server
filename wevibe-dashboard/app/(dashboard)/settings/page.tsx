'use client';

import { useCallback, useEffect, useState } from 'react';
import { getHubResponsePubkey, getHubServingAddress, getOrg, getOrgChainConfig } from '@/lib/hub-client';
import { type DashboardSettings } from '@/lib/settings';
import { connectWallet } from '@/lib/wallet-connect';
import { buildSetOrgConfigMsg, buildSetServingInfoMsg, buildSetServingKeyMsg, directBroadcast, getOrgAccountAddress } from '@/lib/chain-client';
import { txConfirming, txError, txSuccess, txToast } from '@/lib/toast';
import { useOrgContext } from '@/lib/org-context';
import { GuardCard } from '@/components/ui/states';
import InfoTooltip from '@/components/ui/tooltip';

const HUB_RESPONSE_PUBKEY_HEX_PATTERN = /^[0-9a-fA-F]{64}$/;

function normalizeHubEndpoints(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((endpoint): endpoint is string => typeof endpoint === 'string')
    .map((endpoint) => endpoint.trim())
    .filter((endpoint) => endpoint.length > 0)
    .slice(0, 3);
}

function isValidHttpOrHttpsUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export default function SettingsPage() {
  const { activeOrg } = useOrgContext();
  const orgLoaded = activeOrg !== null;
  const isLeader = activeOrg?.role === 'leader';
  const [requiredApprovals, setRequiredApprovals] = useState<number>(1);
  const [reportVoteThreshold, setReportVoteThreshold] = useState<number>(1);
  const [configLoading, setConfigLoading] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configSuccess, setConfigSuccess] = useState<string | null>(null);
  const [savingConfig, setSavingConfig] = useState(false);
  const [chainConfigLoading, setChainConfigLoading] = useState(false);
  const [chainConfigError, setChainConfigError] = useState<string | null>(null);
  const [savingChainConfig, setSavingChainConfig] = useState(false);
  const [serveAttestationRequired, setServeAttestationRequired] = useState(false);
  const [hubServingAddress, setHubServingAddress] = useState('');
  const [hubEndpoints, setHubEndpoints] = useState<string[]>([]);
  const [hubResponsePubkey, setHubResponsePubkey] = useState('');
  const [hubAdvertisedResponsePubkey, setHubAdvertisedResponsePubkey] = useState('');
  const [showServingKeyEditor, setShowServingKeyEditor] = useState(false);
  const [newServingKey, setNewServingKey] = useState('');
  const [hubInfraError, setHubInfraError] = useState<string | null>(null);
  const [hubInfraSuccess, setHubInfraSuccess] = useState<string | null>(null);
  const [savingServingKey, setSavingServingKey] = useState(false);
  const [showServingInfoEditor, setShowServingInfoEditor] = useState(false);
  const [newHubEndpoints, setNewHubEndpoints] = useState<string[]>(['']);
  const [newHubResponsePubkey, setNewHubResponsePubkey] = useState('');
  const [hubServingInfoError, setHubServingInfoError] = useState<string | null>(null);
  const [hubServingInfoSuccess, setHubServingInfoSuccess] = useState<string | null>(null);
  const [savingServingInfo, setSavingServingInfo] = useState(false);

  const resolveOrgAccountForGas = useCallback(async (): Promise<string> => {
    if (!activeOrg) {
      throw new Error('could not resolve org account for gas');
    }

    try {
      const orgAccount = (await getOrgAccountAddress(activeOrg.org_id)).trim();
      if (!orgAccount) {
        throw new Error('missing org account');
      }
      return orgAccount;
    } catch {
      throw new Error('could not resolve org account for gas');
    }
  }, [activeOrg]);

  useEffect(() => {
    if (!activeOrg) {
      return;
    }

    let cancelled = false;
    setConfigLoading(true);
    setConfigError(null);
    setConfigSuccess(null);

    void Promise.all([getOrg(activeOrg.org_id), getHubServingAddress(), getHubResponsePubkey()])
      .then(([summary, fallbackServingAddress, fallbackResponsePubkey]) => {
        if (cancelled) return;

        setRequiredApprovals(summary.required_approvals ?? 1);
        setReportVoteThreshold(summary.report_vote_threshold ?? 1);

        const summaryServingAddress = summary.hub_serving_address ?? summary.hub_serving_key_address;
        const resolvedServingAddress = [
          typeof summaryServingAddress === 'string' ? summaryServingAddress : '',
          fallbackServingAddress,
        ].find((value) => value.trim().length > 0) ?? '';
        setHubServingAddress(resolvedServingAddress);

        setHubEndpoints(normalizeHubEndpoints(summary.hub_endpoints));

        const normalizedFallbackResponsePubkey = fallbackResponsePubkey.trim();
        const resolvedResponsePubkey = [
          typeof summary.hub_response_pubkey === 'string' ? summary.hub_response_pubkey : '',
          normalizedFallbackResponsePubkey,
        ].find((value) => value.trim().length > 0) ?? '';

        setHubResponsePubkey(resolvedResponsePubkey.trim());
        setHubAdvertisedResponsePubkey(normalizedFallbackResponsePubkey);
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
  }, [activeOrg]);

  useEffect(() => {
    if (!activeOrg) {
      return;
    }

    let cancelled = false;
    setChainConfigLoading(true);
    setChainConfigError(null);

    void getOrgChainConfig(activeOrg.org_id)
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
  }, [activeOrg]);

  const handleConfigSave = useCallback(async () => {
    if (!activeOrg) {
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
        activeOrg.org_id,
        false,
        0,
        0,
      );

      const orgAccount = await resolveOrgAccountForGas();
      const result = await directBroadcast(walletConn.address, [msgSetOrgConfig], orgAccount);
      setConfigSuccess(`Moderation settings updated. Tx: ${result.txHash.slice(0, 16)}...`);
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingConfig(false);
    }
  }, [activeOrg, reportVoteThreshold, requiredApprovals, resolveOrgAccountForGas]);

  const handleChainConfigSave = useCallback(async (nextServeAttestationRequired: boolean) => {
    if (!activeOrg) {
      return;
    }

    const toastId = txToast('Chain config');

    setSavingChainConfig(true);
    setChainConfigError(null);

    try {
      const walletConn = await connectWallet();
      txConfirming(toastId, 'Chain config');

      const msgSetOrgConfig = buildSetOrgConfigMsg(
        walletConn.address,
        activeOrg.org_id,
        nextServeAttestationRequired,
        0,
        0,
      );

      const orgAccount = await resolveOrgAccountForGas();
      const result = await directBroadcast(walletConn.address, [msgSetOrgConfig], orgAccount);
      setServeAttestationRequired(nextServeAttestationRequired);
      txSuccess(
        toastId,
        `${nextServeAttestationRequired ? 'Serve attestations enabled' : 'Serve attestations disabled'}. Tx: ${result.txHash.slice(0, 16)}...`,
      );
    } catch (err) {
      txError(toastId, err instanceof Error ? err.message : String(err));
    } finally {
      setSavingChainConfig(false);
    }
  }, [activeOrg, resolveOrgAccountForGas]);

  const handleServingKeySave = useCallback(async () => {
    if (!activeOrg) {
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
        activeOrg.org_id,
        nextServingKey,
      );

      const orgAccount = await resolveOrgAccountForGas();
      const result = await directBroadcast(walletConn.address, [msgSetServingKey], orgAccount);
      setHubServingAddress(nextServingKey);
      setShowServingKeyEditor(false);
      setNewServingKey('');
      setHubInfraSuccess(`Serving key updated. Tx: ${result.txHash.slice(0, 16)}...`);
    } catch (err) {
      setHubInfraError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingServingKey(false);
    }
  }, [activeOrg, newServingKey, resolveOrgAccountForGas]);

  const handleHubEndpointChange = useCallback((index: number, value: string) => {
    setNewHubEndpoints((previous) => previous.map((endpoint, endpointIndex) => (
      endpointIndex === index ? value : endpoint
    )));
  }, []);

  const handleAddHubEndpointRow = useCallback(() => {
    setNewHubEndpoints((previous) => {
      if (previous.length >= 3) {
        return previous;
      }
      return [...previous, ''];
    });
  }, []);

  const handleRemoveHubEndpointRow = useCallback((index: number) => {
    setNewHubEndpoints((previous) => {
      if (previous.length <= 1) {
        return previous;
      }
      return previous.filter((_, endpointIndex) => endpointIndex !== index);
    });
  }, []);

  const handleServingInfoSave = useCallback(async () => {
    if (!activeOrg) {
      return;
    }

    const normalizedEndpoints = newHubEndpoints.map((endpoint) => endpoint.trim());
    if (normalizedEndpoints.length < 1 || normalizedEndpoints.length > 3) {
      setHubServingInfoError('Provide between 1 and 3 hub endpoints.');
      return;
    }
    if (normalizedEndpoints.some((endpoint) => endpoint.length === 0)) {
      setHubServingInfoError('Each hub endpoint row must be non-empty. Remove extra empty rows before broadcast.');
      return;
    }
    if (normalizedEndpoints.some((endpoint) => !isValidHttpOrHttpsUrl(endpoint))) {
      setHubServingInfoError('Hub endpoints must be valid http:// or https:// URLs.');
      return;
    }

    const normalizedResponsePubkey = newHubResponsePubkey.trim();
    if (normalizedResponsePubkey.length > 0 && !HUB_RESPONSE_PUBKEY_HEX_PATTERN.test(normalizedResponsePubkey)) {
      setHubServingInfoError('hub_response_pubkey must be empty or a 64-character hex string.');
      return;
    }

    setSavingServingInfo(true);
    setHubServingInfoError(null);
    setHubServingInfoSuccess(null);

    try {
      const walletConn = await connectWallet();
      const msgSetServingInfo = buildSetServingInfoMsg(
        walletConn.address,
        activeOrg.org_id,
        normalizedEndpoints,
        normalizedResponsePubkey,
      );

      const orgAccount = await resolveOrgAccountForGas();
      const result = await directBroadcast(walletConn.address, [msgSetServingInfo], orgAccount);
      setHubEndpoints(normalizedEndpoints);
      setHubResponsePubkey(normalizedResponsePubkey);
      setShowServingInfoEditor(false);
      setNewHubEndpoints(normalizedEndpoints);
      setNewHubResponsePubkey(normalizedResponsePubkey);
      setHubServingInfoSuccess(`Serving info updated. Tx: ${result.txHash.slice(0, 16)}...`);
    } catch (err) {
      setHubServingInfoError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingServingInfo(false);
    }
  }, [activeOrg, newHubEndpoints, newHubResponsePubkey, resolveOrgAccountForGas]);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Org Settings</h1>
        <p className="text-sm text-wv-dim">
          {activeOrg ? `Leader controls for ${activeOrg.org_name}.` : 'Select or create an org to manage its settings.'}
        </p>
      </header>

      {!activeOrg ? (
        <GuardCard title="Select or create an org to manage its settings." />
      ) : (
        <>
          <section className="rounded-xl border border-wv-line bg-wv-panel p-6 shadow-wv-sm">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-wv-text">Moderation Configuration</h2>
              <InfoTooltip label="About moderation configuration">
                How many moderator approvals a memory needs, and the votes needed to action a report.
              </InfoTooltip>
            </div>
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
                <label htmlFor="required-approvals" className="flex items-center gap-2 text-sm font-medium text-wv-text">
                  <span>Moderator Approvals Required</span>
                  <InfoTooltip label="About approval requirements">
                    How many moderator approvals a memory needs before it can advance.
                  </InfoTooltip>
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
                <label htmlFor="report-vote-threshold" className="flex items-center gap-2 text-sm font-medium text-wv-text">
                  <span>Report Vote Threshold</span>
                  <InfoTooltip label="About report vote threshold">
                    Votes needed to action a report.
                  </InfoTooltip>
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
                {savingConfig ? 'Saving…' : 'Save'}
              </button>
            </div>

            {configLoading && (
              <p className="mt-4 text-xs text-wv-dim">Loading current moderation settings…</p>
            )}
          </section>

          <section className="rounded-xl border border-wv-line bg-wv-panel p-6 shadow-wv-sm">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-wv-text">Chain Configuration</h2>
              <InfoTooltip label="About chain configuration">
                On-chain org settings enforced by the WeVibe chain. Each change is a wallet-signed transaction.
              </InfoTooltip>
            </div>
            <p className="mt-1 text-sm text-wv-dim">
              Manage on-chain org settings via direct wallet-signed transaction broadcast.
            </p>

            {chainConfigError && (
              <div className="mt-4 rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-3 py-2 text-sm text-wv-red">
                {chainConfigError}
              </div>
            )}

            <div className="mt-4 rounded-lg border border-wv-line bg-wv-panel-2 p-4">
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-wv-text">Serve attestations</p>
                      <InfoTooltip label="About serve attestations">
                        Require cryptographic serve attestations before a memory can be served.
                      </InfoTooltip>
                    </div>
                    <p className="mt-1 text-xs text-wv-dim">
                      Current on-chain state:{' '}
                      <span className="font-medium text-wv-text">
                        {serveAttestationRequired ? 'Enabled' : 'Disabled'}
                      </span>
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => handleChainConfigSave(!serveAttestationRequired)}
                    disabled={chainConfigLoading || savingChainConfig || !orgLoaded}
                    className="inline-flex items-center justify-center rounded-lg bg-wv-grad-btn px-4 py-2 text-sm font-medium text-white shadow-wv-sm transition hover:opacity-95 disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
                  >
                    {savingChainConfig
                      ? 'Broadcasting…'
                      : serveAttestationRequired
                        ? 'Disable serve attestations'
                        : 'Enable serve attestations'}
                  </button>
                </div>

                <div className="border-t border-wv-line pt-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-sm font-medium text-wv-text">Auto-renewal</p>
                      <p className="mt-1 text-xs text-wv-dim">Reserved for future chain configuration options.</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="rounded-full border border-wv-line-2 bg-wv-panel-3 px-2.5 py-1 text-xs font-medium text-wv-dim">
                        Unavailable
                      </span>
                      <button
                        type="button"
                        disabled
                        className="inline-flex items-center justify-center rounded-lg border border-wv-line-2 px-3 py-1.5 text-xs font-medium text-wv-dim disabled:cursor-not-allowed"
                      >
                        Unavailable
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {chainConfigLoading && <p className="mt-4 text-xs text-wv-dim">Loading chain config…</p>}
          </section>

          {isLeader && (
            <section className="rounded-xl border border-wv-line bg-wv-panel p-6 shadow-wv-sm">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold text-wv-text">Hub Infrastructure</h2>
                <InfoTooltip label="About hub infrastructure">
                  Advanced: the network endpoints and signing keys your org&apos;s hub uses. Most orgs never change these.
                </InfoTooltip>
              </div>
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

              <div className="mt-6 rounded-lg border border-wv-line bg-wv-panel-2 p-4">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-wv-dim">Hub endpoints &amp; response key</h3>
                <p className="mt-2 text-xs text-wv-dim">
                  Configure ordered hub endpoint failover (1–3 URLs) and the hub response signature key for clients.
                </p>

                <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="rounded-lg border border-wv-line bg-wv-panel px-3 py-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-wv-dim">Current hub_endpoints</p>
                    {hubEndpoints.length > 0 ? (
                      <ol className="mt-2 list-decimal space-y-1 pl-4 text-sm text-wv-text">
                        {hubEndpoints.map((endpoint, index) => (
                          <li key={`${endpoint}-${index}`} className="break-all font-mono text-xs">{endpoint}</li>
                        ))}
                      </ol>
                    ) : (
                      <p className="mt-1 text-sm text-wv-text">—</p>
                    )}
                  </div>

                  <div className="rounded-lg border border-wv-line bg-wv-panel px-3 py-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-wv-dim">Current hub_response_pubkey</p>
                    <p className="mt-1 break-all font-mono text-xs text-wv-text">{hubResponsePubkey || '—'}</p>
                  </div>
                </div>

                <div className="mt-3 rounded-lg border border-wv-line bg-wv-panel px-3 py-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-wv-dim">This hub&apos;s advertised response_pubkey</p>
                  <p className="mt-1 break-all font-mono text-xs text-wv-text">{hubAdvertisedResponsePubkey || '—'}</p>
                </div>

                {hubServingInfoError && (
                  <div className="mt-4 rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-3 py-2 text-sm text-wv-red">
                    {hubServingInfoError}
                  </div>
                )}

                {hubServingInfoSuccess && (
                  <div className="mt-4 rounded-lg border border-[rgba(54,211,153,0.4)] bg-[rgba(54,211,153,0.12)] px-3 py-2 text-sm text-wv-green break-all">
                    {hubServingInfoSuccess}
                  </div>
                )}

                <div className="mt-4">
                  {!showServingInfoEditor ? (
                    <button
                      type="button"
                      onClick={() => {
                        setHubServingInfoError(null);
                        setHubServingInfoSuccess(null);
                        setNewHubEndpoints(hubEndpoints.length > 0 ? [...hubEndpoints] : ['']);
                        setNewHubResponsePubkey(hubResponsePubkey || hubAdvertisedResponsePubkey);
                        setShowServingInfoEditor(true);
                      }}
                      className="inline-flex items-center justify-center rounded-lg border border-wv-line-2 px-4 py-2 text-sm font-medium text-wv-text transition hover:border-[rgba(124,92,255,0.35)] hover:text-wv-violet"
                    >
                      Edit endpoints &amp; response key
                    </button>
                  ) : (
                    <div className="rounded-lg border border-[rgba(124,92,255,0.28)] bg-[rgba(124,92,255,0.08)] p-4">
                      <p className="text-sm font-medium text-wv-text">Ordered hub endpoints (1–3)</p>
                      <div className="mt-3 flex flex-col gap-3">
                        {newHubEndpoints.map((endpoint, index) => (
                          <div key={`new-hub-endpoint-${index}`} className="flex flex-col gap-2 sm:flex-row sm:items-center">
                            <label htmlFor={`new-hub-endpoint-${index}`} className="text-xs font-medium uppercase tracking-wide text-wv-dim sm:w-28">
                              Endpoint {index + 1}
                            </label>
                            <input
                              id={`new-hub-endpoint-${index}`}
                              type="url"
                              value={endpoint}
                              onChange={(event) => handleHubEndpointChange(index, event.target.value)}
                              placeholder="https://hub.example.com"
                              disabled={savingServingInfo}
                              className="w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)] disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
                            />
                            <button
                              type="button"
                              onClick={() => handleRemoveHubEndpointRow(index)}
                              disabled={savingServingInfo || newHubEndpoints.length <= 1}
                              className="inline-flex items-center justify-center rounded-lg border border-wv-line-2 px-3 py-2 text-xs font-medium text-wv-text transition hover:border-[rgba(124,92,255,0.35)] hover:text-wv-violet disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              Remove
                            </button>
                          </div>
                        ))}
                      </div>

                      <div className="mt-3 flex items-center gap-3">
                        <button
                          type="button"
                          onClick={handleAddHubEndpointRow}
                          disabled={savingServingInfo || newHubEndpoints.length >= 3}
                          className="inline-flex items-center justify-center rounded-lg border border-wv-line-2 px-3 py-2 text-xs font-medium text-wv-text transition hover:border-[rgba(124,92,255,0.35)] hover:text-wv-violet disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Add endpoint
                        </button>
                        <span className="text-xs text-wv-dim">{newHubEndpoints.length}/3 configured</span>
                      </div>

                      <div className="mt-4">
                        <label htmlFor="new-hub-response-pubkey" className="block text-sm font-medium text-wv-text">
                          hub_response_pubkey (hex ed25519)
                        </label>
                        <input
                          id="new-hub-response-pubkey"
                          type="text"
                          value={newHubResponsePubkey}
                          onChange={(event) => setNewHubResponsePubkey(event.target.value)}
                          placeholder="64 hex chars (optional)"
                          disabled={savingServingInfo}
                          className="mt-2 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 font-mono text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)] disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
                        />
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setNewHubResponsePubkey(hubAdvertisedResponsePubkey)}
                            disabled={savingServingInfo || !hubAdvertisedResponsePubkey}
                            className="inline-flex items-center justify-center rounded-lg border border-wv-line-2 px-3 py-2 text-xs font-medium text-wv-text transition hover:border-[rgba(124,92,255,0.35)] hover:text-wv-violet disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            Use this hub&apos;s key
                          </button>
                          {!hubAdvertisedResponsePubkey && (
                            <span className="text-xs text-wv-dim">No advertised response key was returned by this hub.</span>
                          )}
                        </div>
                      </div>

                      <div className="mt-4 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={handleServingInfoSave}
                          disabled={savingServingInfo || !orgLoaded}
                          className="inline-flex items-center justify-center rounded-lg bg-wv-grad-btn px-4 py-2 text-sm font-medium text-white shadow-wv-sm transition hover:opacity-95 disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
                        >
                          {savingServingInfo ? 'Broadcasting…' : 'Broadcast MsgSetServingInfo'}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setShowServingInfoEditor(false);
                            setHubServingInfoError(null);
                          }}
                          disabled={savingServingInfo}
                          className="inline-flex items-center justify-center rounded-lg border border-wv-line-2 px-4 py-2 text-sm font-medium text-wv-text transition hover:border-[rgba(124,92,255,0.35)] hover:text-wv-violet disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </section>
          )}

          <section className="rounded-xl border border-wv-line bg-wv-panel p-6 shadow-wv-sm">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-wv-text">Org &amp; LLM Configuration</h2>
              <InfoTooltip label="About org and LLM configuration">
                Default language-model provider and credentials used for this org.
              </InfoTooltip>
            </div>
            <p className="mt-1 text-sm text-wv-dim">
              Configure your organization ID, moderator pubkey, and LLM provider for memory extraction.
            </p>

            <OrgLlamaConfig />
          </section>
        </>
      )}
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
