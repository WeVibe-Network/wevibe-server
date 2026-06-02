'use client';

import { useState } from 'react';
import { setupDelegation, revokeDelegation, isDelegationActive } from '@/lib/delegation';
import { registerDelegateKey } from '@/lib/hub-client';
import { getDelegateKey } from '@/lib/delegate-key';
import Button from '@/components/ui/button';
import Badge from '@/components/ui/badge';

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
    return date.toLocaleDateString();
  }

  if (currentStep === 'complete') {
    return (
      <div className="flex flex-col gap-3 p-4 border border-green-200 rounded-lg bg-green-50">
        <div className="flex items-center gap-2">
          <Badge variant="success">Signing Key Active</Badge>
        </div>
        <div className="text-xs space-y-1">
          <p className="text-gray-600">
            Delegate: <span className="font-mono">{truncateAddress(delegateAddress || '')}</span>
          </p>
          <p className="text-gray-600">
            Expires: <span className="font-mono">{getExpirationDate()}</span>
          </p>
          <p className="text-gray-500 text-[10px]">
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
      <div className="flex flex-col gap-3 p-4 border border-red-200 rounded-lg bg-red-50">
        <p className="text-xs text-red-700">{error}</p>
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
      <div className="flex flex-col gap-2 p-4 border border-gray-200 rounded-lg">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-gray-700">Generating your local signing key...</span>
        </div>
      </div>
    );
  }

  if (currentStep === 'authorizing') {
    return (
      <div className="flex flex-col gap-2 p-4 border border-gray-200 rounded-lg">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-gray-700">Waiting for wallet authorization...</span>
        </div>
        <p className="text-xs text-gray-500">Check your wallet extension</p>
      </div>
    );
  }

  if (currentStep === 'registering') {
    return (
      <div className="flex flex-col gap-2 p-4 border border-gray-200 rounded-lg">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-gray-700">Registering signing key with WeVibe...</span>
        </div>
      </div>
    );
  }

  if (currentStep === 'revoking') {
    return (
      <div className="flex flex-col gap-2 p-4 border border-gray-200 rounded-lg">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 border-2 border-red-600 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-gray-700">Revoking signing key...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="text-xs text-gray-600">
        <p className="mb-2">Your wallet will be asked to authorize WeVibe operations. This is a one-time setup.</p>
        <p className="font-medium mb-1">Permissions being granted:</p>
        <ul className="list-disc list-inside text-gray-500 space-y-0.5">
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
