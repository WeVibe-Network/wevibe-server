import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { isAbsolute, join, relative, resolve } from 'path';

export interface SubstrateEvent {
  kind: 'user' | 'assistant' | 'reasoning' | 'tool' | 'edit';
  time: number;
  seq: number;
  role?: string;
  text?: string;
  name?: string;
  input?: string;
  output?: string;
  exit?: number | null;
  status?: string;
  error?: string;
  file?: string;
  detail?: string;
}

interface SessionRow {
  directory: string;
}

interface PartRow {
  pdata: string;
  mdata: string;
  part_time_created: number | string | null;
  message_time_created: number | string | null;
}

const EDIT_TOOL_NAMES = new Set(['edit', 'write', 'patch', 'multiedit', 'apply_patch']);
const PATCH_TARGET_PREFIXES = ['*** Update File:', '*** Add File:', '*** Delete File:'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stableNormalize(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((entry) => stableNormalize(entry, seen));
  }

  if (value && typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);

    const obj = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      normalized[key] = stableNormalize(obj[key], seen);
    }

    seen.delete(value);
    return normalized;
  }

  return value;
}

function stableSerialize(value: unknown): string {
  try {
    const normalized = stableNormalize(value, new WeakSet<object>());
    const serialized = JSON.stringify(normalized);
    return typeof serialized === 'string' ? serialized : '';
  } catch {
    return '';
  }
}

function toEpochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    return Math.trunc(numeric);
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    return null;
  }

  return parsed;
}

function resolveEventTime(partTime: unknown, messageTime: unknown): number {
  return toEpochMs(partTime) ?? toEpochMs(messageTime) ?? 0;
}

function extractRole(messageData: Record<string, unknown> | null): string | undefined {
  if (!messageData) {
    return undefined;
  }

  const role = messageData.role;
  if (typeof role !== 'string') {
    return undefined;
  }

  const trimmed = role.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function extractExitCode(state: Record<string, unknown>): number | null | undefined {
  const candidateKeys = ['exit', 'exit_code', 'exitCode'];
  for (const key of candidateKeys) {
    if (!hasOwn(state, key)) {
      continue;
    }

    const value = state[key];
    if (value === null) {
      return null;
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.trunc(value);
    }

    if (typeof value === 'string') {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) {
        return Math.trunc(parsed);
      }
    }

    break;
  }

  return undefined;
}

function extractPatchTarget(patchText: string): string | undefined {
  const lines = patchText.split(/\r?\n/);
  for (const line of lines) {
    for (const prefix of PATCH_TARGET_PREFIXES) {
      if (!line.startsWith(prefix)) {
        continue;
      }
      const target = line.slice(prefix.length).trim();
      if (target.length > 0) {
        return target;
      }
    }
  }

  return undefined;
}

function extractEditFilePath(input: unknown): string | undefined {
  if (isRecord(input)) {
    const keys = ['filePath', 'path', 'file', 'filepath', 'file_path', 'targetPath'];
    for (const key of keys) {
      const value = input[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
    }

    const patchKeys = ['patchText', 'patch', 'diff'];
    for (const patchKey of patchKeys) {
      const patchText = input[patchKey];
      if (typeof patchText !== 'string' || patchText.length === 0) {
        continue;
      }

      const patchTarget = extractPatchTarget(patchText);
      if (patchTarget) {
        return patchTarget;
      }
    }

    return undefined;
  }

  if (typeof input === 'string') {
    return extractPatchTarget(input);
  }

  return undefined;
}

function relativizeToSessionDir(filePath: string, sessionDirectory: string): string {
  const trimmedFilePath = filePath.trim();
  if (trimmedFilePath.length === 0) {
    return trimmedFilePath;
  }

  const trimmedSessionDirectory = sessionDirectory.trim();
  if (trimmedSessionDirectory.length === 0) {
    return trimmedFilePath;
  }

  if (!isAbsolute(trimmedFilePath) || !isAbsolute(trimmedSessionDirectory)) {
    return trimmedFilePath;
  }

  const normalizedFilePath = resolve(trimmedFilePath);
  const normalizedSessionDirectory = resolve(trimmedSessionDirectory);
  const relativePath = relative(normalizedSessionDirectory, normalizedFilePath);
  if (
    relativePath.length > 0
    && !relativePath.startsWith('..')
    && !isAbsolute(relativePath)
  ) {
    return relativePath;
  }

  return trimmedFilePath;
}

function serializeToolOutput(state: Record<string, unknown>): string | undefined {
  if (!hasOwn(state, 'output')) {
    return undefined;
  }

  const output = state.output;
  if (typeof output === 'string') {
    return output;
  }

  const serialized = stableSerialize(output);
  return serialized.length > 0 ? serialized : undefined;
}

function mapPartRowToEvent(row: PartRow, sessionDirectory: string, seq: number): SubstrateEvent | null {
  const partData = parseJsonRecord(row.pdata);
  if (!partData) {
    return null;
  }

  const messageData = parseJsonRecord(row.mdata);
  const role = extractRole(messageData);
  const time = resolveEventTime(row.part_time_created, row.message_time_created);

  if (partData.type === 'text') {
    if (typeof partData.text !== 'string') {
      return null;
    }

    if (role === 'user') {
      return {
        kind: 'user',
        time,
        seq,
        role: 'user',
        text: partData.text,
      };
    }

    return {
      kind: 'assistant',
      time,
      seq,
      role: 'assistant',
      text: partData.text,
    };
  }

  if (partData.type === 'reasoning') {
    if (typeof partData.text !== 'string') {
      return null;
    }

    return {
      kind: 'reasoning',
      time,
      seq,
      ...(role ? { role } : {}),
      text: partData.text,
    };
  }

  if (partData.type !== 'tool') {
    return null;
  }

  const toolName =
    typeof partData.tool === 'string'
      ? (partData.tool.trim().length > 0 ? partData.tool : 'tool')
      : partData.tool !== undefined && partData.tool !== null
        ? String(partData.tool)
        : 'tool';
  const state = isRecord(partData.state) ? partData.state : {};
  const input = state.input;

  if (EDIT_TOOL_NAMES.has(toolName.toLowerCase())) {
    const detail = stableSerialize(input);
    const event: SubstrateEvent = {
      kind: 'edit',
      time,
      seq,
      name: toolName,
    };

    const sourcePath = extractEditFilePath(input);
    if (sourcePath) {
      event.file = relativizeToSessionDir(sourcePath, sessionDirectory);
    }

    if (detail.length > 0) {
      event.detail = detail;
    }

    return event;
  }

  const toolEvent: SubstrateEvent = {
    kind: 'tool',
    time,
    seq,
    name: toolName,
  };

  const serializedInput = stableSerialize(input);
  if (serializedInput.length > 0) {
    toolEvent.input = serializedInput;
  }

  const serializedOutput = serializeToolOutput(state);
  if (typeof serializedOutput === 'string') {
    toolEvent.output = serializedOutput;
  }

  const exit = extractExitCode(state);
  if (exit !== undefined) {
    toolEvent.exit = exit;
  }

  if (typeof state.status === 'string') {
    toolEvent.status = state.status;
  }

  if (typeof state.error === 'string') {
    toolEvent.error = state.error;
  }

  return toolEvent;
}

export function getDbPath(): string {
  return (
    process.env.OPENCODE_DB_PATH
    ?? join(homedir(), '.local', 'share', 'opencode', 'opencode.db')
  );
}

export function fetchSessionEvents(sessionId: string): SubstrateEvent[] {
  const normalizedSessionId = sessionId.trim();
  if (normalizedSessionId.length === 0) {
    return [];
  }

  const dbPath = getDbPath();
  if (!existsSync(dbPath)) {
    return [];
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });

    const session = db
      .prepare('SELECT COALESCE(directory, \'\') AS directory FROM session WHERE id = ?')
      .get(normalizedSessionId) as SessionRow | undefined;

    if (!session) {
      return [];
    }

    const rows = db
      .prepare(
        `SELECT
          p.data AS pdata,
          m.data AS mdata,
          p.time_created AS part_time_created,
          m.time_created AS message_time_created
         FROM part p
         JOIN message m ON m.id = p.message_id
         WHERE p.session_id = ?
         ORDER BY m.time_created ASC, m.rowid ASC, p.time_created ASC, p.rowid ASC`,
      )
      .all(normalizedSessionId) as PartRow[];

    const events: SubstrateEvent[] = [];
    rows.forEach((row, seq) => {
      const mapped = mapPartRowToEvent(row, session.directory, seq);
      if (mapped) {
        events.push(mapped);
      }
    });

    return events;
  } finally {
    db?.close();
  }
}
