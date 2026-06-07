import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export const dynamic = 'force-dynamic';

interface MessageRow {
  id: string;
  data: string;
}

interface PartRow {
  pdata: string;
  mdata: string;
}

function getDbPath(): string {
  return (
    process.env.OPENCODE_DB_PATH ??
    join(homedir(), '.local', 'share', 'opencode', 'opencode.db')
  );
}

function extractTranscript(rows: PartRow[]): string {
  const lines: string[] = [];

  for (const row of rows) {
    let partData: Record<string, unknown>;

    try {
      partData = JSON.parse(row.pdata) as Record<string, unknown>;
    } catch {
      // Skip malformed parts
      continue;
    }

    let role = 'unknown';
    try {
      const messageData = JSON.parse(row.mdata) as { role?: string };
      role = messageData.role ?? 'unknown';
    } catch {
      // Keep unknown role if message payload is malformed
    }

    if (partData.type === 'text') {
      const text = partData.text;
      if (typeof text === 'string' && text.trim().length > 0) {
        lines.push(`[${role}] ${text}`);
      }
      continue;
    }

    if (partData.type === 'reasoning') {
      const text = partData.text;
      if (typeof text === 'string' && text.trim().length > 0) {
        lines.push(`[${role}:reasoning] ${text}`);
      }
      continue;
    }

    if (partData.type === 'tool') {
      const tool = partData.tool ?? 'tool';
      const state = (partData.state ?? {}) as {
        input?: unknown;
        output?: unknown;
      };
      const input = state.input ?? {};

      let inputStr: string;
      if (
        typeof input === 'object' &&
        input !== null &&
        'command' in input &&
        typeof (input as { command?: unknown }).command === 'string'
      ) {
        inputStr = (input as { command: string }).command;
      } else {
        const inputJson = JSON.stringify(input);
        inputStr = typeof inputJson === 'string' ? inputJson.slice(0, 300) : '';
      }

      const out = state.output;
      let outStr = '';
      if (typeof out === 'string') {
        outStr = out.slice(0, 300);
      } else if (out) {
        const outJson = JSON.stringify(out);
        outStr = typeof outJson === 'string' ? outJson.slice(0, 300) : '';
      }

      lines.push(`[${role}:tool] ${String(tool)}(${inputStr})${outStr ? ` -> ${outStr}` : ''}`);
    }
  }

  let transcript = lines.join('\n\n');
  if (transcript.length > 120000) {
    transcript = `${transcript.slice(0, 120000)}\n\n[transcript truncated]`;
  }

  return transcript;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const dbPath = getDbPath();

  if (!existsSync(dbPath)) {
    return NextResponse.json({ error: 'OpenCode database not found' }, { status: 404 });
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });

    const session = db
      .prepare('SELECT id, title, model, directory FROM session WHERE id = ?')
      .get(id) as { id: string; title: string; model: string; directory: string } | undefined;

    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    const messages = db
      .prepare('SELECT id, data FROM message WHERE session_id = ? ORDER BY rowid ASC')
      .all(id) as MessageRow[];

    const parts = db
      .prepare(
        `SELECT p.data AS pdata, m.data AS mdata
         FROM part p
         JOIN message m ON m.id = p.message_id
         WHERE p.session_id = ?
         ORDER BY m.time_created ASC, m.rowid ASC, p.time_created ASC, p.rowid ASC`,
      )
      .all(id) as PartRow[];

    const transcript = extractTranscript(parts);

    return NextResponse.json({
      session_id: id,
      title: session.title,
      model: session.model,
      directory: session.directory,
      message_count: messages.length,
      transcript,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to read messages: ${(err as Error).message}` },
      { status: 500 },
    );
  } finally {
    db?.close();
  }
}
