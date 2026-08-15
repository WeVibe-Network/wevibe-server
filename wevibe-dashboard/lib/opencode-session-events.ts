import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export function getDbPath(): string {
  const configured = process.env.OPENCODE_DB_PATH?.trim();
  return configured || join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

export function getSessionTitle(sessionId: string): string {
  const normalizedSessionId = sessionId.trim();
  if (normalizedSessionId.length === 0) {
    return '';
  }

  const dbPath = getDbPath();
  if (!existsSync(dbPath)) {
    return '';
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db
      .prepare('SELECT COALESCE(title, \'\') AS title FROM session WHERE id = ?')
      .get(normalizedSessionId) as { title: string } | undefined;
    return row && typeof row.title === 'string' ? row.title : '';
  } finally {
    db?.close();
  }
}
