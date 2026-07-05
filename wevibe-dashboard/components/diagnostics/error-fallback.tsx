'use client';

import type { FallbackProps } from 'react-error-boundary';

export function ErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  const message = error instanceof Error ? error.message : String(error);

  return (
    <div className="flex min-h-[40vh] items-center justify-center p-6">
      <div className="w-full max-w-xl rounded-xl border border-wv-red/40 bg-wv-panel p-6 shadow-wv-sm">
        <h2 className="text-lg font-semibold text-wv-red">Something went wrong</h2>
        <p className="mt-3 break-words rounded-md bg-wv-panel-2 p-3 font-mono text-sm text-wv-text">
          {message}
        </p>
        <button
          type="button"
          onClick={resetErrorBoundary}
          className="mt-4 rounded-md bg-wv-grad-btn px-4 py-2 text-sm font-medium text-white"
        >
          Reload
        </button>
      </div>
    </div>
  );
}
