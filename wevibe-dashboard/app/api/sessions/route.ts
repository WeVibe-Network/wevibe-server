import { NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { SessionSummary } from '@/lib/session-types';

export const dynamic = 'force-dynamic';

function getDbPath(): string {
  return (
    process.env.OPENCODE_DB_PATH ??
    join(homedir(), '.local', 'share', 'opencode', 'opencode.db')
  );
}

export async function GET() {
  const dbPath = getDbPath();

  if (!existsSync(dbPath)) {
    return NextResponse.json(
      { sessions: [], error: 'OpenCode database not found. Expected at: ' + dbPath },
      { status: 200 },
    );
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });

    const sessions = db
      .prepare(
        `SELECT
          s.id,
          COALESCE(s.title, 'Untitled Session') as title,
          COALESCE(s.model, '') as model,
          COALESCE(s.agent, '') as agent,
          COALESCE(s.directory, '') as directory,
          s.time_created,
          s.time_updated,
          COUNT(m.id) as message_count
        FROM session s
        LEFT JOIN message m ON m.session_id = s.id
        GROUP BY s.id
        ORDER BY s.time_updated DESC`,
      )
      .all() as SessionSummary[];

    return NextResponse.json({ sessions });
  } catch (err) {
    return NextResponse.json(
      { sessions: [], error: `Failed to read sessions: ${(err as Error).message}` },
      { status: 500 },
    );
  } finally {
    db?.close();
  }
}
