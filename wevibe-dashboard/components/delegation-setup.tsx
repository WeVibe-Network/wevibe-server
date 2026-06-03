'use client';

import { useState } from 'react';
import { setupDelegation, revokeDelegation, isDelegationActive } from '@/lib/delegation';
import { registerDelegateKey } from '@/lib/hub-client';
import { getDelegateKey } from '@/lib/delegate-key';
import Button from '@/components/ui/button';
import Badge from '@/components/ui/badge';
import ClientTime from '@/components/ui/client-time';

interface DelegationSetupProps {
  walletAddress: string;
  orgId: string;
  onDelegationComplete?: () => void;
}

type Step = 'idle' | 'generating' | 'authorizing' | 'registering' | 'complete' | 'error' | 'revoking';

export function DelegationSetup({ walletAddress, orgId, onDelegationComplete }: DelegationSetupProps) {
  const [currentStep, setCurrentStep] = useState<Step>('idle');
  const [delegateAddress, setDelegateAddress] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSetup() {
    setCurrentStep('generating');
    setError(null);

    try {
      const result = await setupDelegation(walletAddress);
      setDelegateAddress(result.delegateAddress);
      setTxHash(result.txHash);
      setCurrentStep('registering');

      await registerDelegateKey(orgId, walletAddress, result.delegateAddress, result.txHash);

      setCurrentStep('complete');
      onDelegationComplete?.();
    } catch (err) {
      setCurrentStep('error');
      setError(err instanceof Error ? err.message : 'Setup failed');
    }
  }

  async function handleRevoke() {
    setCurrentStep('revoking');
    setError(null);

    try {
      await revokeDelegation(walletAddress);
      setCurrentStep('idle');
      setDelegateAddress(null);
      setTxHash(null);
    } catch (err) {
      setCurrentStep('error');
      setError(err instanceof Error ? err.message : 'Revocation failed');
    }
  }

  function truncateAddress(addr: string): string {
    if (addr.length <= 16) return addr;
    return `${addr.slice(0, 10)}...${addr.slice(-6)}`;
  }

  function getExpirationDate(): string {
    const date = new Date();
    date.setDate(date.getDate() + 90);
    return date.toISOString();
  }

  if (currentStep === 'complete') {
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-[rgba(54,211,153,0.4)] bg-[rgba(54,211,153,0.12)] p-4">
        <div className="flex items-center gap-2">
          <Badge variant="success">Signing Key Active</Badge>
        </div>
        <div className="space-y-1 text-xs">
          <p className="font-mono text-wv-dim">
            Delegate: <span className="font-mono">{truncateAddress(delegateAddress || '')}</span>
          </p>
          <p className="font-mono text-wv-dim">
            Expires:{' '}
            <span className="font-mono">
              <ClientTime value={getExpirationDate()} mode="date" />
            </span>
          </p>
          <p className="font-mono text-[10px] text-wv-faint">
            Tx: {txHash}
          </p>
        </div>
        <Button variant="primary" onClick={handleRevoke}>
          Revoke Signing Key
        </Button>
      </div>
    );
  }

  if (currentStep === 'error') {
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] p-4">
        <p className="text-xs text-wv-red">{error}</p>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setCurrentStep('idle')}>
            Retry
          </Button>
          {delegateAddress && (
            <Button variant="primary" onClick={handleRevoke}>
              Revoke
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (currentStep === 'generating') {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-wv-line bg-wv-panel p-4">
        <div className="flex items-center gap-2">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-wv-violet border-t-transparent" />
          <span className="text-sm text-wv-text">Generating your local signing key...</span>
        </div>
      </div>
    );
  }

  if (currentStep === 'authorizing') {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-wv-line bg-wv-panel p-4">
        <div className="flex items-center gap-2">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-wv-violet border-t-transparent" />
          <span className="text-sm text-wv-text">Waiting for wallet authorization...</span>
        </div>
        <p className="text-xs text-wv-dim">Check your wallet extension</p>
      </div>
    );
  }

  if (currentStep === 'registering') {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-wv-line bg-wv-panel p-4">
        <div className="flex items-center gap-2">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-wv-violet border-t-transparent" />
          <span className="text-sm text-wv-text">Registering signing key with WeVibe...</span>
        </div>
      </div>
    );
  }

  if (currentStep === 'revoking') {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-wv-line bg-wv-panel p-4">
        <div className="flex items-center gap-2">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-wv-red border-t-transparent" />
          <span className="text-sm text-wv-text">Revoking signing key...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="text-xs text-wv-dim">
        <p className="mb-2">Your wallet will be asked to authorize WeVibe operations. This is a one-time setup.</p>
        <p className="font-medium mb-1">Permissions being granted:</p>
        <ul className="list-inside list-disc space-y-0.5 text-wv-dim">
          <li>Submit memory commitments</li>
          <li>Approve/reject memory</li>
          <li>Submit serve batches</li>
          <li>Manage org membership</li>
          <li>Update reputation</li>
        </ul>
      </div>
      <Button onClick={handleSetup}>
        Set Up Signing Key
      </Button>
    </div>
  );
}
