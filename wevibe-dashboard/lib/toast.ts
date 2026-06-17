import { toast } from 'sonner';

function shortenTxHash(txHash: string): string {
  if (txHash.length <= 20) {
    return txHash;
  }

  return `${txHash.slice(0, 12)}…${txHash.slice(-6)}`;
}

export function txToast(label: string): string | number {
  return toast.loading(`${label}: submitting…`);
}

export function txConfirming(id: string | number, label: string): void {
  toast.loading(`${label}: confirming on chain…`, { id });
}

export function txSuccess(id: string | number, message: string, txHash?: string): void {
  const normalizedTxHash = txHash?.trim();

  if (normalizedTxHash) {
    toast.success(message, {
      id,
      description: `Tx: ${shortenTxHash(normalizedTxHash)}`,
    });
    return;
  }

  toast.success(message, { id });
}

export function txError(id: string | number, message: string, description?: string): void {
  const normalizedDescription = description?.trim();

  if (normalizedDescription) {
    toast.error(message, { id, description: normalizedDescription });
    return;
  }

  toast.error(message, { id });
}
