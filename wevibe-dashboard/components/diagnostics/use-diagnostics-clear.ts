'use client';

import { useCallback, useState } from 'react';
import { toast } from 'sonner';

import type { DiagnosticsClearState } from '@/lib/diagnostics-types';

/**
 * Shared "Clear diagnostics" logic used by BOTH the /diagnostics page and the
 * connection-error modal (R-13 one path — no duplicated clear logic).
 *
 * Clear is a NON-DESTRUCTIVE view filter: it POSTs a `cleared_at` marker to the
 * server (persisted in wevibe-meta/.logs) so subsequent /api/errors reads hide
 * entries at/before that timestamp. It does NOT delete logs and does NOT fix a
 * still-happening live error — the caller's `onCleared` should optimistically
 * empty the visible list and re-fetch (which will return only newer entries).
 *
 * @param onCleared invoked after a successful clear (empty + refetch there).
 */
export function useDiagnosticsClear(onCleared: () => void): { clearing: boolean; clear: () => Promise<string | null> } {
  const [clearing, setClearing] = useState(false);

  const clear = useCallback(async (): Promise<string | null> => {
    setClearing(true);
    try {
      const response = await fetch('/api/errors/clear', { method: 'POST', cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Clear failed (${response.status})`);
      }

      const data = (await response.json()) as DiagnosticsClearState;
      toast.success('Cleared errors from view (logs are not deleted)');
      onCleared();
      return data.cleared_at ?? null;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to clear errors';
      toast.error(message);
      return null;
    } finally {
      setClearing(false);
    }
  }, [onCleared]);

  return { clearing, clear };
}
