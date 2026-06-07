'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getHubResponsePubkey, getHubServingAddress, getOrg, getOrgChainConfig } from '@/lib/hub-client';
import { type DashboardSettings } from '@/lib/settings';
import { connectWallet } from '@/lib/wallet-connect';
import {
  buildSetExtractionProfileMsg,
  buildSetOrgConfigMsg,
  buildSetServingInfoMsg,
  buildSetServingKeyMsg,
  directBroadcast,
  getExtractionProfile,
  getOrgAccountAddress,
} from '@/lib/chain-client';
import { txConfirming, txError, txSuccess, txToast } from '@/lib/toast';
import { useOrgContext } from '@/lib/org-context';
import { GuardCard } from '@/components/ui/states';
import InfoTooltip from '@/components/ui/tooltip';

const HUB_RESPONSE_PUBKEY_HEX_PATTERN = /^[0-9a-fA-F]{64}$/;
const EXTRACTION_MODEL_MAX_BYTES = 256;
const EXTRACTION_SYSTEM_PROMPT_MAX_BYTES = 8192;
const EXTRACTION_OUTPUT_SCHEMA_MAX_BYTES = 4096;
const EXTRACTION_DOMAIN_FRAMING_MAX_BYTES = 1024;
const EXTRACTION_CONSTRAINTS_MAX_BYTES = 4096;
const EXTRACTION_EXEMPLAR_MAX_BYTES = 4096;
const EXTRACTION_EXEMPLARS_MAX = 5;
const EXTRACTION_NUM_CTX_MAX = 131072;
const EXTRACTION_TOTAL_STRING_BYTES_MAX = 16384;

function byteLengthUtf8(value: string): number {
  return new TextEncoder().encode(value).length;
}

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
  const [extractionProfileLoading, setExtractionProfileLoading] = useState(false);
  const [extractionProfileError, setExtractionProfileError] = useState<string | null>(null);
  const [extractionProfileSuccess, setExtractionProfileSuccess] = useState<string | null>(null);
  const [savingExtractionProfile, setSavingExtractionProfile] = useState(false);
  const [extractionProfileVersion, setExtractionProfileVersion] = useState<number | null>(null);
  const [extractionProfileUpdatedAtHeight, setExtractionProfileUpdatedAtHeight] = useState<string | null>(null);
  const [extractionModel, setExtractionModel] = useState('');
  const [extractionNumCtx, setExtractionNumCtx] = useState('');
  const [extractionSystemPrompt, setExtractionSystemPrompt] = useState('');
  const [extractionOutputSchema, setExtractionOutputSchema] = useState('');
  const [extractionDomainFraming, setExtractionDomainFraming] = useState('');
  const [extractionConstraints, setExtractionConstraints] = useState('');
  const [extractionExemplars, setExtractionExemplars] = useState<string[]>(['']);

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
    if (!activeOrg || !isLeader) {
      setExtractionProfileLoading(false);
      setExtractionProfileError(null);
      setExtractionProfileSuccess(null);
      setExtractionProfileVersion(null);
      setExtractionProfileUpdatedAtHeight(null);
      setExtractionModel('');
      setExtractionNumCtx('');
      setExtractionSystemPrompt('');
      setExtractionOutputSchema('');
      setExtractionDomainFraming('');
      setExtractionConstraints('');
      setExtractionExemplars(['']);
      return;
    }

    let cancelled = false;
    setExtractionProfileLoading(true);
    setExtractionProfileError(null);
    setExtractionProfileSuccess(null);

    void getExtractionProfile(activeOrg.org_id)
      .then((profile) => {
        if (cancelled) {
          return;
        }

        if (!profile) {
          setExtractionProfileVersion(null);
          setExtractionProfileUpdatedAtHeight(null);
          setExtractionModel('');
          setExtractionNumCtx('');
          setExtractionSystemPrompt('');
          setExtractionOutputSchema('');
          setExtractionDomainFraming('');
          setExtractionConstraints('');
          setExtractionExemplars(['']);
          return;
        }

        setExtractionProfileVersion(profile.profile_version);
        setExtractionProfileUpdatedAtHeight(profile.updated_at_height);
        setExtractionModel(profile.extraction_model);
        setExtractionNumCtx(profile.num_ctx > 0 ? String(profile.num_ctx) : '');
        setExtractionSystemPrompt(profile.system_prompt);
        setExtractionOutputSchema(profile.output_schema);
        setExtractionDomainFraming(profile.domain_framing);
        setExtractionConstraints(profile.constraints);
        setExtractionExemplars(profile.exemplars.length > 0 ? [...profile.exemplars] : ['']);
      })
      .catch((err) => {
        if (cancelled) {
          return;
        }
        setExtractionProfileError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) {
          setExtractionProfileLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeOrg, isLeader]);

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

  const extractionValidation = useMemo(() => {
    const extractionModelBytes = byteLengthUtf8(extractionModel);
    const systemPromptBytes = byteLengthUtf8(extractionSystemPrompt);
    const outputSchemaBytes = byteLengthUtf8(extractionOutputSchema);
    const domainFramingBytes = byteLengthUtf8(extractionDomainFraming);
    const constraintsBytes = byteLengthUtf8(extractionConstraints);
    const exemplarByteLengths = extractionExemplars.map((exemplar) => byteLengthUtf8(exemplar));

    const totalStringBytes = extractionModelBytes
      + systemPromptBytes
      + outputSchemaBytes
      + domainFramingBytes
      + constraintsBytes
      + exemplarByteLengths.reduce((total, next) => total + next, 0);

    const extractionModelError = extractionModelBytes > EXTRACTION_MODEL_MAX_BYTES
      ? `extraction_model exceeds ${EXTRACTION_MODEL_MAX_BYTES} bytes.`
      : null;
    const systemPromptError = systemPromptBytes > EXTRACTION_SYSTEM_PROMPT_MAX_BYTES
      ? `system_prompt exceeds ${EXTRACTION_SYSTEM_PROMPT_MAX_BYTES} bytes.`
      : null;
    const outputSchemaError = outputSchemaBytes > EXTRACTION_OUTPUT_SCHEMA_MAX_BYTES
      ? `output_schema exceeds ${EXTRACTION_OUTPUT_SCHEMA_MAX_BYTES} bytes.`
      : null;
    const domainFramingError = domainFramingBytes > EXTRACTION_DOMAIN_FRAMING_MAX_BYTES
      ? `domain_framing exceeds ${EXTRACTION_DOMAIN_FRAMING_MAX_BYTES} bytes.`
      : null;
    const constraintsError = constraintsBytes > EXTRACTION_CONSTRAINTS_MAX_BYTES
      ? `constraints exceeds ${EXTRACTION_CONSTRAINTS_MAX_BYTES} bytes.`
      : null;

    const exemplarFieldErrors = exemplarByteLengths.map((bytes, index) => (
      bytes > EXTRACTION_EXEMPLAR_MAX_BYTES
        ? `Exemplar ${index + 1} exceeds ${EXTRACTION_EXEMPLAR_MAX_BYTES} bytes.`
        : null
    ));

    const exemplarCountError = extractionExemplars.length > EXTRACTION_EXEMPLARS_MAX
      ? `No more than ${EXTRACTION_EXEMPLARS_MAX} exemplars are allowed.`
      : null;

    const trimmedNumCtx = extractionNumCtx.trim();
    let parsedNumCtx: number | null = null;
    let numCtxError: string | null = null;
    if (trimmedNumCtx.length === 0) {
      numCtxError = 'num_ctx is required.';
    } else {
      const parsed = Number(trimmedNumCtx);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
        numCtxError = 'num_ctx must be a positive integer.';
      } else if (parsed > EXTRACTION_NUM_CTX_MAX) {
        numCtxError = `num_ctx cannot exceed ${EXTRACTION_NUM_CTX_MAX}.`;
      } else {
        parsedNumCtx = parsed;
      }
    }

    const totalStringBytesError = totalStringBytes > EXTRACTION_TOTAL_STRING_BYTES_MAX
      ? `Total UTF-8 string bytes exceed ${EXTRACTION_TOTAL_STRING_BYTES_MAX}.`
      : null;

    const hasErrors = Boolean(
      extractionModelError
      || systemPromptError
      || outputSchemaError
      || domainFramingError
      || constraintsError
      || exemplarCountError
      || numCtxError
      || totalStringBytesError
      || exemplarFieldErrors.some((entry) => entry !== null),
    );

    return {
      parsedNumCtx,
      hasErrors,
      bytes: {
        extractionModel: extractionModelBytes,
        systemPrompt: systemPromptBytes,
        outputSchema: outputSchemaBytes,
        domainFraming: domainFramingBytes,
        constraints: constraintsBytes,
        exemplars: exemplarByteLengths,
      },
      totalStringBytes,
      errors: {
        extractionModel: extractionModelError,
        systemPrompt: systemPromptError,
        outputSchema: outputSchemaError,
        domainFraming: domainFramingError,
        constraints: constraintsError,
        exemplars: exemplarFieldErrors,
        exemplarCount: exemplarCountError,
        numCtx: numCtxError,
        totalBytes: totalStringBytesError,
      },
    };
  }, [
    extractionConstraints,
    extractionDomainFraming,
    extractionExemplars,
    extractionModel,
    extractionNumCtx,
    extractionOutputSchema,
    extractionSystemPrompt,
  ]);

  const handleExtractionExemplarChange = useCallback((index: number, value: string) => {
    setExtractionExemplars((previous) => previous.map((exemplar, exemplarIndex) => (
      exemplarIndex === index ? value : exemplar
    )));
  }, []);

  const handleAddExtractionExemplar = useCallback(() => {
    setExtractionExemplars((previous) => {
      if (previous.length >= EXTRACTION_EXEMPLARS_MAX) {
        return previous;
      }
      return [...previous, ''];
    });
  }, []);

  const handleRemoveExtractionExemplar = useCallback((index: number) => {
    setExtractionExemplars((previous) => {
      if (previous.length <= 1) {
        return previous;
      }
      return previous.filter((_, exemplarIndex) => exemplarIndex !== index);
    });
  }, []);

  const handleExtractionProfileSave = useCallback(async () => {
    if (!activeOrg) {
      return;
    }

    if (extractionValidation.hasErrors || extractionValidation.parsedNumCtx === null) {
      setExtractionProfileError('Resolve extraction profile validation errors before saving.');
      return;
    }

    const normalizedExemplars = extractionExemplars
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .slice(0, EXTRACTION_EXEMPLARS_MAX);
    const toastId = txToast('Extraction profile');

    setSavingExtractionProfile(true);
    setExtractionProfileError(null);
    setExtractionProfileSuccess(null);

    try {
      const walletConn = await connectWallet();
      txConfirming(toastId, 'Extraction profile');

      const msgSetExtractionProfile = buildSetExtractionProfileMsg(
        walletConn.address,
        activeOrg.org_id,
        {
          extractionModel: extractionModel.trim(),
          numCtx: extractionValidation.parsedNumCtx,
          systemPrompt: extractionSystemPrompt,
          outputSchema: extractionOutputSchema,
          domainFraming: extractionDomainFraming,
          exemplars: normalizedExemplars,
          constraints: extractionConstraints,
        },
      );

      const orgAccount = await resolveOrgAccountForGas();
      const result = await directBroadcast(walletConn.address, [msgSetExtractionProfile], orgAccount);

      let refreshedProfile: Awaited<ReturnType<typeof getExtractionProfile>> = null;
      try {
        refreshedProfile = await getExtractionProfile(activeOrg.org_id);
      } catch {
        refreshedProfile = null;
      }

      if (refreshedProfile) {
        setExtractionProfileVersion(refreshedProfile.profile_version);
        setExtractionProfileUpdatedAtHeight(refreshedProfile.updated_at_height);
        setExtractionModel(refreshedProfile.extraction_model);
        setExtractionNumCtx(refreshedProfile.num_ctx > 0 ? String(refreshedProfile.num_ctx) : '');
        setExtractionSystemPrompt(refreshedProfile.system_prompt);
        setExtractionOutputSchema(refreshedProfile.output_schema);
        setExtractionDomainFraming(refreshedProfile.domain_framing);
        setExtractionConstraints(refreshedProfile.constraints);
        setExtractionExemplars(refreshedProfile.exemplars.length > 0 ? [...refreshedProfile.exemplars] : ['']);
      }

      const nextVersion = refreshedProfile?.profile_version
        ?? (extractionProfileVersion !== null ? extractionProfileVersion + 1 : null);
      if (!refreshedProfile && nextVersion !== null) {
        setExtractionProfileVersion(nextVersion);
      }

      const versionLabel = nextVersion !== null ? `v${nextVersion}` : 'next profile version';
      const successMessage = `Extraction profile updated (${versionLabel}). Tx: ${result.txHash.slice(0, 16)}...`;
      setExtractionProfileSuccess(successMessage);
      txSuccess(toastId, successMessage);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setExtractionProfileError(message);
      txError(toastId, message);
    } finally {
      setSavingExtractionProfile(false);
    }
  }, [
    activeOrg,
    extractionConstraints,
    extractionDomainFraming,
    extractionExemplars,
    extractionModel,
    extractionOutputSchema,
    extractionProfileVersion,
    extractionSystemPrompt,
    extractionValidation,
    resolveOrgAccountForGas,
  ]);

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
            <>
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

              <section className="rounded-xl border border-wv-line bg-wv-panel p-6 shadow-wv-sm">
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-semibold text-wv-text">Extraction Profile</h2>
                  <InfoTooltip label="About extraction profile">
                    Leader-owned extraction defaults written on-chain and imported by contributors at extraction time.
                  </InfoTooltip>
                </div>
                <p className="mt-1 text-sm text-wv-dim">
                  Contributors import this profile at extraction time; it shapes every memory&apos;s quality and recall.
                </p>

                <div className="mt-4 rounded-lg border border-wv-line bg-wv-panel-2 px-4 py-3 text-xs text-wv-dim">
                  <p>
                    profile_version:{' '}
                    <span className="font-mono text-wv-text">{extractionProfileVersion ?? '—'}</span>
                  </p>
                  <p className="mt-1">
                    updated_at_height:{' '}
                    <span className="font-mono text-wv-text">{extractionProfileUpdatedAtHeight ?? '—'}</span>
                  </p>
                </div>

                {extractionProfileError && (
                  <div className="mt-4 rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-3 py-2 text-sm text-wv-red">
                    {extractionProfileError}
                  </div>
                )}

                {extractionProfileSuccess && (
                  <div className="mt-4 rounded-lg border border-[rgba(54,211,153,0.4)] bg-[rgba(54,211,153,0.12)] px-3 py-2 text-sm text-wv-green break-all">
                    {extractionProfileSuccess}
                  </div>
                )}

                <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label htmlFor="extraction-model" className="block text-sm font-medium text-wv-text">
                      extraction_model
                    </label>
                    <input
                      id="extraction-model"
                      type="text"
                      value={extractionModel}
                      onChange={(event) => setExtractionModel(event.target.value)}
                      placeholder="qwen2.5:14b"
                      disabled={savingExtractionProfile || extractionProfileLoading}
                      className="mt-2 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)] disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
                    />
                    <p className={`mt-2 text-xs ${extractionValidation.errors.extractionModel ? 'text-wv-red' : 'text-wv-dim'}`}>
                      {extractionValidation.bytes.extractionModel}/{EXTRACTION_MODEL_MAX_BYTES} bytes
                    </p>
                    {extractionValidation.errors.extractionModel && (
                      <p className="mt-1 text-xs text-wv-red">{extractionValidation.errors.extractionModel}</p>
                    )}
                  </div>

                  <div>
                    <label htmlFor="extraction-num-ctx" className="block text-sm font-medium text-wv-text">
                      num_ctx
                    </label>
                    <input
                      id="extraction-num-ctx"
                      type="number"
                      min={1}
                      max={EXTRACTION_NUM_CTX_MAX}
                      step={1}
                      value={extractionNumCtx}
                      onChange={(event) => setExtractionNumCtx(event.target.value)}
                      placeholder="4096"
                      disabled={savingExtractionProfile || extractionProfileLoading}
                      className="mt-2 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)] disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
                    />
                    <p className={`mt-2 text-xs ${extractionValidation.errors.numCtx ? 'text-wv-red' : 'text-wv-dim'}`}>
                      Max {EXTRACTION_NUM_CTX_MAX}
                    </p>
                    {extractionValidation.errors.numCtx && (
                      <p className="mt-1 text-xs text-wv-red">{extractionValidation.errors.numCtx}</p>
                    )}
                  </div>
                </div>

                <div className="mt-4">
                  <label htmlFor="extraction-system-prompt" className="block text-sm font-medium text-wv-text">
                    system_prompt
                  </label>
                  <textarea
                    id="extraction-system-prompt"
                    rows={6}
                    value={extractionSystemPrompt}
                    onChange={(event) => setExtractionSystemPrompt(event.target.value)}
                    placeholder="System instructions used by extraction."
                    disabled={savingExtractionProfile || extractionProfileLoading}
                    className="mt-2 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)] disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
                  />
                  <p className={`mt-2 text-xs ${extractionValidation.errors.systemPrompt ? 'text-wv-red' : 'text-wv-dim'}`}>
                    {extractionValidation.bytes.systemPrompt}/{EXTRACTION_SYSTEM_PROMPT_MAX_BYTES} bytes
                  </p>
                  {extractionValidation.errors.systemPrompt && (
                    <p className="mt-1 text-xs text-wv-red">{extractionValidation.errors.systemPrompt}</p>
                  )}
                </div>

                <div className="mt-4">
                  <label htmlFor="extraction-output-schema" className="block text-sm font-medium text-wv-text">
                    output_schema
                  </label>
                  <textarea
                    id="extraction-output-schema"
                    rows={5}
                    value={extractionOutputSchema}
                    onChange={(event) => setExtractionOutputSchema(event.target.value)}
                    placeholder="JSON schema or shape constraints for extraction output."
                    disabled={savingExtractionProfile || extractionProfileLoading}
                    className="mt-2 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)] disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
                  />
                  <p className={`mt-2 text-xs ${extractionValidation.errors.outputSchema ? 'text-wv-red' : 'text-wv-dim'}`}>
                    {extractionValidation.bytes.outputSchema}/{EXTRACTION_OUTPUT_SCHEMA_MAX_BYTES} bytes
                  </p>
                  {extractionValidation.errors.outputSchema && (
                    <p className="mt-1 text-xs text-wv-red">{extractionValidation.errors.outputSchema}</p>
                  )}
                </div>

                <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label htmlFor="extraction-domain-framing" className="block text-sm font-medium text-wv-text">
                      domain_framing
                    </label>
                    <textarea
                      id="extraction-domain-framing"
                      rows={4}
                      value={extractionDomainFraming}
                      onChange={(event) => setExtractionDomainFraming(event.target.value)}
                      placeholder="Domain-specific framing and vocabulary."
                      disabled={savingExtractionProfile || extractionProfileLoading}
                      className="mt-2 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)] disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
                    />
                    <p className={`mt-2 text-xs ${extractionValidation.errors.domainFraming ? 'text-wv-red' : 'text-wv-dim'}`}>
                      {extractionValidation.bytes.domainFraming}/{EXTRACTION_DOMAIN_FRAMING_MAX_BYTES} bytes
                    </p>
                    {extractionValidation.errors.domainFraming && (
                      <p className="mt-1 text-xs text-wv-red">{extractionValidation.errors.domainFraming}</p>
                    )}
                  </div>

                  <div>
                    <label htmlFor="extraction-constraints" className="block text-sm font-medium text-wv-text">
                      constraints
                    </label>
                    <textarea
                      id="extraction-constraints"
                      rows={4}
                      value={extractionConstraints}
                      onChange={(event) => setExtractionConstraints(event.target.value)}
                      placeholder="Hard constraints for extraction quality and safety."
                      disabled={savingExtractionProfile || extractionProfileLoading}
                      className="mt-2 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)] disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
                    />
                    <p className={`mt-2 text-xs ${extractionValidation.errors.constraints ? 'text-wv-red' : 'text-wv-dim'}`}>
                      {extractionValidation.bytes.constraints}/{EXTRACTION_CONSTRAINTS_MAX_BYTES} bytes
                    </p>
                    {extractionValidation.errors.constraints && (
                      <p className="mt-1 text-xs text-wv-red">{extractionValidation.errors.constraints}</p>
                    )}
                  </div>
                </div>

                <div className="mt-4 rounded-lg border border-wv-line bg-wv-panel-2 p-4">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-wv-text">exemplars</p>
                    <span className="text-xs text-wv-dim">{extractionExemplars.length}/{EXTRACTION_EXEMPLARS_MAX}</span>
                  </div>
                  {extractionValidation.errors.exemplarCount && (
                    <p className="mt-2 text-xs text-wv-red">{extractionValidation.errors.exemplarCount}</p>
                  )}

                  <div className="mt-3 flex flex-col gap-3">
                    {extractionExemplars.map((exemplar, index) => (
                      <div key={`extraction-exemplar-${index}`} className="rounded-lg border border-wv-line bg-wv-panel px-3 py-3">
                        <div className="flex items-center justify-between gap-2">
                          <label htmlFor={`extraction-exemplar-${index}`} className="text-xs font-semibold uppercase tracking-wide text-wv-dim">
                            Exemplar {index + 1}
                          </label>
                          <button
                            type="button"
                            onClick={() => handleRemoveExtractionExemplar(index)}
                            disabled={savingExtractionProfile || extractionProfileLoading || extractionExemplars.length <= 1}
                            className="inline-flex items-center justify-center rounded-lg border border-wv-line-2 px-2.5 py-1.5 text-xs font-medium text-wv-text transition hover:border-[rgba(124,92,255,0.35)] hover:text-wv-violet disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            Remove
                          </button>
                        </div>
                        <textarea
                          id={`extraction-exemplar-${index}`}
                          rows={4}
                          value={exemplar}
                          onChange={(event) => handleExtractionExemplarChange(index, event.target.value)}
                          placeholder="Example extraction input/output pair or guidance snippet."
                          disabled={savingExtractionProfile || extractionProfileLoading}
                          className="mt-2 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)] disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
                        />
                        <p className={`mt-2 text-xs ${extractionValidation.errors.exemplars[index] ? 'text-wv-red' : 'text-wv-dim'}`}>
                          {extractionValidation.bytes.exemplars[index] ?? 0}/{EXTRACTION_EXEMPLAR_MAX_BYTES} bytes
                        </p>
                        {extractionValidation.errors.exemplars[index] && (
                          <p className="mt-1 text-xs text-wv-red">{extractionValidation.errors.exemplars[index]}</p>
                        )}
                      </div>
                    ))}
                  </div>

                  <button
                    type="button"
                    onClick={handleAddExtractionExemplar}
                    disabled={savingExtractionProfile || extractionProfileLoading || extractionExemplars.length >= EXTRACTION_EXEMPLARS_MAX}
                    className="mt-3 inline-flex items-center justify-center rounded-lg border border-wv-line-2 px-3 py-2 text-xs font-medium text-wv-text transition hover:border-[rgba(124,92,255,0.35)] hover:text-wv-violet disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Add exemplar
                  </button>
                </div>

                <div className="mt-4 rounded-lg border border-wv-line bg-wv-panel-2 px-3 py-2">
                  <p className={`text-xs ${extractionValidation.errors.totalBytes ? 'text-wv-red' : 'text-wv-dim'}`}>
                    Total UTF-8 string bytes: {extractionValidation.totalStringBytes}/{EXTRACTION_TOTAL_STRING_BYTES_MAX}
                  </p>
                  {extractionValidation.errors.totalBytes && (
                    <p className="mt-1 text-xs text-wv-red">{extractionValidation.errors.totalBytes}</p>
                  )}
                </div>

                <div className="mt-4 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleExtractionProfileSave}
                    disabled={savingExtractionProfile || extractionProfileLoading || extractionValidation.hasErrors || !orgLoaded}
                    className="inline-flex items-center justify-center rounded-lg bg-wv-grad-btn px-4 py-2 text-sm font-medium text-white shadow-wv-sm transition hover:opacity-95 disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
                  >
                    {savingExtractionProfile ? 'Broadcasting…' : 'Broadcast MsgSetExtractionProfile'}
                  </button>
                </div>

                {extractionProfileLoading && (
                  <p className="mt-4 text-xs text-wv-dim">Loading on-chain extraction profile…</p>
                )}
              </section>
            </>
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
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [modelsError, setModelsError] = useState(false);

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

  useEffect(() => {
    if (!settings || settings.llm_provider !== 'ollama') {
      setOllamaModels([]);
      setModelsError(false);
      return;
    }

    let cancelled = false;

    fetch('/api/ollama-models')
      .then(response => response.json() as Promise<{ models?: unknown; error?: unknown }>)
      .then((data) => {
        if (cancelled) {
          return;
        }

        const models = Array.isArray(data.models)
          ? data.models.filter((model): model is string => typeof model === 'string')
          : [];

        setOllamaModels(models);
        setModelsError(Boolean(data.error) || models.length === 0);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setOllamaModels([]);
        setModelsError(true);
      });

    return () => {
      cancelled = true;
    };
  }, [settings?.llm_provider, settings?.ollama_url]);

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
            {ollamaModels.length > 0 ? (
              <>
                <select
                  id="ollama-model"
                  value={settings.ollama_model}
                  onChange={e => setSettings(s => s ? { ...s, ollama_model: e.target.value } : s)}
                  className="mt-1 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)]"
                >
                  {settings.ollama_model && !ollamaModels.includes(settings.ollama_model) && (
                    <option value={settings.ollama_model}>{settings.ollama_model}</option>
                  )}
                  {ollamaModels.map((model) => (
                    <option key={model} value={model}>{model}</option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-wv-dim">Detected from your local Ollama.</p>
              </>
            ) : (
              <>
                <input
                  id="ollama-model"
                  type="text"
                  value={settings.ollama_model}
                  onChange={e => setSettings(s => s ? { ...s, ollama_model: e.target.value } : s)}
                  placeholder="qwen2.5:14b"
                  className="mt-1 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)]"
                />
                {modelsError && (
                  <p className="mt-1 text-xs text-wv-dim">Could not reach Ollama at {settings.ollama_url} — enter a model name manually.</p>
                )}
              </>
            )}
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
