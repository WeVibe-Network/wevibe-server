export class HubError extends Error {
  readonly code?: string;
  readonly detail?: string;
  readonly status: number;

  constructor(message: string, opts: { code?: string; detail?: string; status: number }) {
    super(message);
    this.name = 'HubError';
    this.code = opts.code;
    this.detail = opts.detail;
    this.status = opts.status;
  }
}

export function isHubError(e: unknown): e is HubError {
  return e instanceof HubError;
}
