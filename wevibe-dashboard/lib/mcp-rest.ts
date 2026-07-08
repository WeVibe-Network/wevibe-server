import { useEffect, useState } from 'react';

export const MCP_ROUTES = {
  queue: '/api/mcp/queue',
  decryptBatch: '/api/mcp/decrypt-batch',
  embedRetrievalCard: '/api/mcp/embed-retrieval-card',
  history: '/api/mcp/history',
} as const;

export type McpRestState = 'connecting' | 'connected' | 'error';

type McpRestListener = (state: McpRestState) => void;

let currentState: McpRestState = 'connecting';
const listeners = new Set<McpRestListener>();
let intervalId: number | null = null;

function setMcpRestState(nextState: McpRestState): void {
  if (currentState === nextState) {
    return;
  }

  currentState = nextState;
  for (const listener of listeners) {
    listener(currentState);
  }
}

function subscribe(listener: McpRestListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

async function pollMcpHealth(): Promise<void> {
  try {
    const res = await fetch('/api/mcp-health', { cache: 'no-store' });
    if (!res.ok) {
      setMcpRestState('error');
      return;
    }

    const body = (await res.json()) as { alive?: boolean };
    setMcpRestState(body.alive === true ? 'connected' : 'error');
  } catch {
    setMcpRestState('error');
  }
}

function startPolling(): void {
  if (typeof window === 'undefined' || intervalId !== null) {
    return;
  }

  void pollMcpHealth();
  intervalId = window.setInterval(() => {
    void pollMcpHealth();
  }, 20_000);
}

export function getMcpRestState(): McpRestState {
  if (typeof window === 'undefined') {
    return 'connecting';
  }

  startPolling();
  return currentState;
}

export function useMcpRestState(): McpRestState {
  const [state, setState] = useState<McpRestState>(() => getMcpRestState());

  useEffect(() => {
    startPolling();
    const unsubscribe = subscribe(setState);
    setState(currentState);
    return unsubscribe;
  }, []);

  return state;
}

export async function callMcpTool<T>(path: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });

  if (!res.ok) {
    let message = `MCP request failed (${res.status})`;

    try {
      const body = (await res.json()) as { error?: unknown };
      if (body && typeof body.error === 'string') {
        message = body.error;
      }
    } catch {
      // ignore non-JSON errors
    }

    throw new Error(message);
  }

  return (await res.json()) as T;
}
