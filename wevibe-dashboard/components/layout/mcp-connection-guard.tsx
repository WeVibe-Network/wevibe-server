'use client';

import Link from 'next/link';
import { type JSX, type ReactNode, useEffect, useState } from 'react';
import { type ConnectionState, getMcpClient } from '@/lib/mcp-client';

export default function McpConnectionGuard({ children }: { children: ReactNode }): JSX.Element {
  const [state, setState] = useState<ConnectionState>('disconnected');

  useEffect(() => {
    const client = getMcpClient();
    setState(client.state);

    const unsubscribe = client.addStateListener(setState);
    void client.connect().catch(() => {});

    return () => {
      unsubscribe();
    };
  }, []);

  if (state !== 'connected') {
    return (
      <div className="rounded-lg border border-[rgba(52,220,240,0.4)] bg-[rgba(52,220,240,0.12)] p-4 text-wv-cyan">
        <p className="font-medium">No MCP session detected ({state}).</p>
        <p className="mt-2 text-sm text-wv-cyan">
          Open <Link href="/settings" className="font-medium text-wv-violet underline-offset-2 hover:underline">Settings</Link>{' '}
          and connect to your local wevibe-mcp --dashboard server (http://localhost:4451).
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
