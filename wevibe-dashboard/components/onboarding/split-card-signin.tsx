'use client';

import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { IdentityOnboarding } from '@/components/onboarding/identity-onboarding';
import Button from '@/components/ui/button';
import Card from '@/components/ui/card';
import {
  adoptIdentityFromLocalMcp,
  adoptIdentityFromWallet,
  clearIdentity,
  createGuestIdentity,
  WalletUnlockMismatchError,
} from '@/lib/wevibe-auth';
import { buildWalletErrorDetail, copyToClipboard } from '@/lib/copy-error';
import { connectWallet, detectWallets, getChainConfig, type WalletProvider } from '@/lib/wallet-connect';

const NO_WALLET_MESSAGE =
  'No wallet found. Install the Keplr or Leap browser extension to sign in with a wallet.';

/**
 * HARD error toast for the wallet half of the split-card sign-in (WO-UX-2
 * sentinel pathway). Short user-facing toast + a "Copy error" action that
 * copies the FULL error detail (name, message, stack, wallet diagnostic)
 * via the shared lib/copy-error helpers. The user stays on the modal.
 */
function showHardWalletError(err: unknown, detected: WalletProvider[]): void {
  const full = buildWalletErrorDetail(err, {
    chainId: getChainConfig().chainId,
    detectedWallets: detected,
  });

  toast.error('No wallet found', {
    description: 'Install the Keplr or Leap extension, then try again.',
    duration: 8000,
    action: {
      label: 'Copy error',
      onClick: () => {
        void (async () => {
          const ok = await copyToClipboard(full);
          if (ok) {
            toast.success('Error copied to clipboard');
          } else {
            toast.error('Failed to copy error');
          }
        })();
      },
    },
  });
}

/**
 * Distinct toast for the wallet-unlock-mismatch case: a DIFFERENT wallet
 * signed than the one that created the identity, so the KEK cannot unwrap.
 * Minting silently here would orphan the existing identity, so the default
 * stays "sign with the right wallet" — but the local record MUST be clearable,
 * otherwise a stale record with no matching wallet is an unrecoverable dead
 * end with no path back to sign-in. "Reset" drops the LOCAL record only; the
 * hub blob is untouched and the original wallet can still adopt it.
 */
function showWalletUnlockError(onReset: () => void): void {
  toast.error("This wallet doesn't unlock this identity", {
    description:
      'Sign in with the wallet that created this identity, or reset to start fresh on this device.',
    duration: 12000,
    action: {
      label: 'Reset identity',
      onClick: onReset,
    },
  });
}

export function SplitCardSignin({ onReady }: { onReady: () => void | Promise<void> }) {
  const [busy, setBusy] = useState(false);

  const handleWalletSignIn = useCallback(async () => {
    if (busy) return;
    setBusy(true);

    try {
      const wallets = typeof window === 'undefined' ? [] : detectWallets();

      if (wallets.length === 0) {
        showHardWalletError(new Error(NO_WALLET_MESSAGE), wallets);
        return;
      }

      const conn = await connectWallet(wallets[0]);
      const address = conn.address;

      // 1. Adopt the LOCAL leader MCP's identity first. This is the convergent
      //    case and must win: org-setup runs through the MCP and signs with the
      //    MCP's own identity, so a browser holding any OTHER key creates an org
      //    it cannot then see (/my-org resolves orgs by the BROWSER pubkey).
      //    Minting ahead of this is what produces orphaned orgs.
      try {
        await adoptIdentityFromLocalMcp(address);
        await onReady();
        return;
      } catch {
        // no local identity / MCP offline → fall through to the cross-device path.
      }

      // 2. Adopt an existing wallet-wrapped identity from the hub (cross-device,
      //    no local MCP on this machine).
      try {
        await adoptIdentityFromWallet(address);
        await onReady();
        return;
      } catch (err) {
        if (err instanceof WalletUnlockMismatchError) {
          throw err; // hard stop — wrong wallet signs; never mint over an existing identity
        }
        // NoWalletIdentityError (no blob) or transient hub/network error → mint.
      }

      // 3. Genuinely no identity anywhere — mint + upload the wallet-wrapped blob.
      await createGuestIdentity(address);
      await onReady();
    } catch (err) {
      const detected = typeof window === 'undefined' ? [] : detectWallets();
      if (err instanceof WalletUnlockMismatchError) {
        showWalletUnlockError(() => {
          void (async () => {
            try {
              await clearIdentity();
              toast.success('Identity reset — sign in again with any wallet');
            } catch (resetErr) {
              showHardWalletError(resetErr, detected);
            }
          })();
        });
      } else {
        showHardWalletError(err, detected);
      }
    } finally {
      setBusy(false);
    }
  }, [busy, onReady]);

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 px-4 py-8">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="split-card-signin-title"
        className="w-full max-w-3xl rounded-lg border border-wv-line bg-wv-panel p-6 shadow-wv-sm"
      >
        <h2 id="split-card-signin-title" className="font-sans text-base font-semibold text-wv-violet">
          Sign in to WeVibe
        </h2>
        <p className="mt-1 text-sm text-wv-dim">
          Choose how to protect your dashboard identity.
        </p>

        <div className="mt-6 grid items-start gap-6 md:grid-cols-2">
          <div className="flex flex-col gap-3">
            <div>
              <h3 className="text-lg font-semibold text-wv-text">Passkey</h3>
              <p className="text-sm text-wv-dim">Windows Hello / Mac biometric</p>
            </div>
            <IdentityOnboarding onReady={onReady} />
          </div>

          <div className="flex flex-col gap-3">
            <div>
              <h3 className="text-lg font-semibold text-wv-text">Wallet</h3>
              <p className="text-sm text-wv-dim">Keplr / Leap browser extension</p>
            </div>
            <Card className="flex flex-1 flex-col gap-4 p-6">
              <p className="text-sm text-wv-dim">
                Sign with your wallet to access your WeVibe identity. If none
                exists yet, one is created and encrypted with your wallet — no
                passkey required.
              </p>
              <Button type="button" onClick={() => void handleWalletSignIn()} disabled={busy}>
                {busy ? 'Connecting…' : 'Sign in with wallet'}
              </Button>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
