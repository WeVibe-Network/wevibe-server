export type ErrorKind = 'needs_gas' | 'forbidden' | 'conflict' | 'network' | 'unknown';

function extractStatus(err: unknown): number | null {
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const status = (err as { status?: number }).status;
    if (typeof status === 'number') {
      return status;
    }
  }

  return null;
}

function extractMessage(err: unknown): string {
  if (typeof err === 'string') {
    return err.toLowerCase();
  }

  if (err instanceof Error) {
    return err.message.toLowerCase();
  }

  if (typeof err === 'object' && err !== null && 'message' in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string') {
      return message.toLowerCase();
    }
  }

  return String(err).toLowerCase();
}

export function classifyError(err: unknown): ErrorKind {
  const status = extractStatus(err);
  const message = extractMessage(err);

  if (
    message.includes('insufficient funds')
    || message.includes('insufficient fee')
    || message.includes('out of gas')
    || message.includes('not enough')
    || message.includes('insufficient balance')
    || message.includes('does not exist on chain')
    || message.includes('does not exist')
    || message.includes('account does not exist')
    || message.includes('send some tokens')
    || message.includes('unknown address')
    || message.includes('account sequence')
  ) {
    return 'needs_gas';
  }

  if (
    status === 401
    || status === 403
    || message.includes('unauthorized')
    || message.includes('forbidden')
    || message.includes('not a member')
    || message.includes('moderators only')
  ) {
    return 'forbidden';
  }

  if (
    status === 409
    || message.includes('already exists')
    || message.includes('already own')
  ) {
    return 'conflict';
  }

  if (
    status === 0
    || status === 502
    || status === 503
    || status === 504
    || message.includes('failed to fetch')
    || message.includes('networkerror')
    || message.includes('load failed')
    || message.includes('network request failed')
  ) {
    return 'network';
  }

  return 'unknown';
}
