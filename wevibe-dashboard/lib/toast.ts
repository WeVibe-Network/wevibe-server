import { toast } from 'sonner';

export function txToast(label: string): string | number {
  return toast.loading(`${label}: submitting…`);
}

export function txConfirming(id: string | number, label: string): void {
  toast.loading(`${label}: confirming on chain…`, { id });
}

export function txSuccess(id: string | number, message: string): void {
  toast.success(message, { id });
}

export function txError(id: string | number, message: string): void {
  toast.error(message, { id });
}
