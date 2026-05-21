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

function getDbPath(): string {
  return (
    process.env.OPENCODE_DB_PATH ??
    join(homedir(), '.local', 'share', 'opencode', 'opencode.db')
  );
}

function extractTranscript(messages: MessageRow[]): string {
  const lines: string[] = [];

  for (const msg of messages) {
    try {
      const data = JSON.parse(msg.data);
      const role = data.role ?? 'unknown';

      if (typeof data.content === 'string') {
        lines.push(`[${role}] ${data.content}`);
      } else if (Array.isArray(data.content)) {
        for (const part of data.content) {
          if (part.type === 'text' && typeof part.text === 'string') {
            lines.push(`[${role}] ${part.text}`);
          } else if (part.type === 'tool_use') {
            lines.push(`[${role}:tool] ${part.name ?? 'tool'}(${JSON.stringify(part.input ?? {}).slice(0, 200)})`);
          } else if (part.type === 'tool_result') {
            const content = typeof part.content === 'string'
              ? part.content.slice(0, 500)
              : JSON.stringify(part.content ?? '').slice(0, 500);
            lines.push(`[tool_result] ${content}`);
          }
        }
      }
    } catch {
      // Skip malformed messages
    }
  }

  return lines.join('\n\n');
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

    const transcript = extractTranscript(messages);

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