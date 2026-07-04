import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export const dynamic = 'force-dynamic';

// Tool transcript bounds:
// - edit/write keep full input/output so fix diffs are preserved.
// - bash keeps command input uncapped via the existing command branch and caps output at 4000 chars.
// - all other tools cap input/output at 2000 chars.
const TOOL_INPUT_MAX = 2000;
const TOOL_OUTPUT_MAX = 2000;
const TOOL_OUTPUT_BASH_MAX = 4000;

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
      const toolName = String(tool);
      const isFixTool = toolName === 'edit' || toolName === 'write';
      const toolInputMax = isFixTool ? null : TOOL_INPUT_MAX;
      const toolOutputMax = isFixTool
        ? null
        : toolName === 'bash'
          ? TOOL_OUTPUT_BASH_MAX
          : TOOL_OUTPUT_MAX;
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
        if (typeof inputJson === 'string') {
          inputStr = toolInputMax === null ? inputJson : inputJson.slice(0, toolInputMax);
        } else {
          inputStr = '';
        }
      }

      const out = state.output;
      let outStr = '';
      if (typeof out === 'string') {
        outStr = toolOutputMax === null ? out : out.slice(0, toolOutputMax);
      } else if (out) {
        const outJson = JSON.stringify(out);
        if (typeof outJson === 'string') {
          outStr = toolOutputMax === null ? outJson : outJson.slice(0, toolOutputMax);
        }
      }

      lines.push(`[${role}:tool] ${String(tool)}(${inputStr})${outStr ? ` -> ${outStr}` : ''}`);
    }
  }

  // The extractor now budgets/chunks against the model context window (75% rule);
  // truncating here would re-introduce transcript tail loss.
  const transcript = lines.join('\n\n');

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
