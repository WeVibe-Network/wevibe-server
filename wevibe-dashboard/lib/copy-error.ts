'use client';

// Shared clipboard helper + wallet-error detail builder for the sign-in
// "copy error" sentinel pathway (WO-UX-2). copyToClipboard is the ONE
// copy util new callers should use; existing inline navigator.clipboard
// sites are left as-is.

/**
 * Copy `text` to the clipboard. Returns true on success; returns false
 * (never throws) on any failure — missing clipboard API (SSR/older
 * browsers), permission denial, or a rejected write. The caller decides
 * how to surface failure (e.g. a toast) and may toast on success.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * PURE (no DOM / window / clipboard access; Node-import-safe). Assembles
 * the full error-detail string the "copy error" button copies: the error
 * message, error name and stack trace when present, plus the wallet
 * detection diagnostic (chainId + detected wallet providers).
 */
export function buildWalletErrorDetail(
  err: unknown,
  diagnostics: { chainId: string; detectedWallets: string[] },
): string {
  const isError = err instanceof Error;
  const message = isError ? err.message : String(err);

  const lines: string[] = [];
  if (isError && err.name) {
    lines.push(`Error name: ${err.name}`);
  }
  lines.push(`Message: ${message}`);
  if (isError && err.stack) {
    lines.push('Stack:');
    lines.push(err.stack);
  }
  const detected = diagnostics.detectedWallets.join(',');
  lines.push(
    `Wallet diagnostic: chainId=${diagnostics.chainId} detected=${detected.length > 0 ? detected : 'none'}`,
  );
  return lines.join('\n');
}
