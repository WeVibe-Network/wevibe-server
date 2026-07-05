import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';

import {
  DIAGNOSTICS_DEFAULTS,
  DIAGNOSTIC_SERVICES,
  type DiagnosticEntry,
  type DiagnosticLevel,
  type DiagnosticsQuery,
  type DiagnosticsResponse,
} from '@/lib/diagnostics-types';
import { readClearMarker } from '@/lib/diagnostics-clear-marker';
import { TRACE_HEADER, logOp, resolveLogDir, resolveTraceId } from '@/lib/logger';

export const dynamic = 'force-dynamic';

const STRUCTURED_LINE_RE = /^(\d{4}-\d{2}-\d{2}T\S+)\s+(INFO|WARN|ERROR)\s*(.*)$/;
const ERROR_LINE_RE = /\b(ERROR|panic|FATAL|fatal|uncaught|unhandled|Invalid|failed|Error:)\b/;
const WARN_LINE_RE = /\b(WARN|warning)\b/i;

const RAW_CAPTURE_FILES: ReadonlyArray<{ fileName: string; service: string }> = [
  { fileName: 'umbral-sidecar.log', service: 'umbral' },
  { fileName: 'host-mcp-4450.log', service: 'mcp' },
  { fileName: 'wevibe-plugin-errors.log', service: 'plugin' },
  { fileName: 'contributor-dashboard.log', service: 'dashboard' },
];

const MCP_OP_PREFIXES = ['http.request', 'extract', 'sidecar', 'recall', 'retrieve', 'served_store', 'org.setup'];
const KNOWN_SERVICES = new Set<string>(DIAGNOSTIC_SERVICES as readonly string[]);

type ParseToken = { key: string; value: string };

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value === null || value === undefined) {
    return '';
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return stringifyValue(error);
}

function formatNoteError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return stringifyValue(error);
}

function toIsoTimestamp(value: unknown, fallback?: string): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return fallback;
}

function parsePositiveInt(value: string | null, fallback: number, max: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

function normalizeLevel(level: string): DiagnosticLevel | undefined {
  const upper = level.toUpperCase();
  if (upper === 'ERROR' || upper === 'WARN' || upper === 'INFO') {
    return upper;
  }
  return undefined;
}

function parseLevels(levelsRaw: string | null): DiagnosticLevel[] {
  if (!levelsRaw) {
    return [...DIAGNOSTICS_DEFAULTS.levels];
  }

  const unique = new Set<DiagnosticLevel>();
  for (const part of levelsRaw.split(',')) {
    const normalized = normalizeLevel(part.trim());
    if (normalized) {
      unique.add(normalized);
    }
  }

  if (unique.size === 0) {
    return [...DIAGNOSTICS_DEFAULTS.levels];
  }
  return [...unique];
}

function parseQuery(requestUrl: string): DiagnosticsQuery {
  const url = new URL(requestUrl);
  const serviceRaw = url.searchParams.get('service');
  const service = serviceRaw?.trim().toLowerCase() || undefined;

  return {
    levels: parseLevels(url.searchParams.get('levels')),
    limit: parsePositiveInt(url.searchParams.get('limit'), DIAGNOSTICS_DEFAULTS.limit, 10_000),
    sinceHours: parsePositiveInt(url.searchParams.get('sinceHours'), DIAGNOSTICS_DEFAULTS.sinceHours, 24 * 30),
    service,
    includeCleared: url.searchParams.get('includeCleared') === 'true',
  };
}

function parseKeyValueTokens(segment: string): ParseToken[] | null {
  const tokens: ParseToken[] = [];
  let index = 0;

  while (index < segment.length) {
    while (index < segment.length && segment[index] === ' ') {
      index += 1;
    }
    if (index >= segment.length) {
      break;
    }

    const keyStart = index;
    while (index < segment.length && segment[index] !== '=' && segment[index] !== ' ') {
      index += 1;
    }

    const key = segment.slice(keyStart, index).trim();
    if (!key || index >= segment.length || segment[index] !== '=') {
      while (index < segment.length && segment[index] !== ' ') {
        index += 1;
      }
      continue;
    }

    index += 1; // skip '='

    let value = '';
    if (index < segment.length && segment[index] === '"') {
      index += 1;
      let closed = false;

      while (index < segment.length) {
        const ch = segment[index];
        if (ch === '\\') {
          if (index + 1 < segment.length) {
            value += segment[index + 1];
            index += 2;
            continue;
          }
          index += 1;
          continue;
        }
        if (ch === '"') {
          closed = true;
          index += 1;
          break;
        }
        value += ch;
        index += 1;
      }

      if (!closed) {
        return null;
      }
    } else {
      const valueStart = index;
      while (index < segment.length && segment[index] !== ' ') {
        index += 1;
      }
      value = segment.slice(valueStart, index);
    }

    tokens.push({ key, value });
  }

  return tokens;
}

function formatTokenValue(token: ParseToken): string {
  if (!/[\s=]/.test(token.value)) {
    return `${token.key}=${token.value}`;
  }
  const escaped = token.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `${token.key}="${escaped}"`;
}

function mapServiceFromOp(op: string): string {
  const normalized = op.trim();
  if (!normalized) {
    return 'other';
  }
  if (normalized.startsWith('dashboard')) {
    return 'dashboard';
  }
  if (normalized.startsWith('client')) {
    return 'client';
  }
  if (normalized.startsWith('hub')) {
    return 'hub';
  }
  if (MCP_OP_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return 'mcp';
  }
  const firstSegment = normalized.split('.')[0]?.trim();
  if (!firstSegment) {
    return 'other';
  }
  return KNOWN_SERVICES.has(firstSegment) ? firstSegment : firstSegment || 'other';
}

function parseStructuredLine(line: string): DiagnosticEntry | null {
  const match = STRUCTURED_LINE_RE.exec(line);
  if (!match) {
    return null;
  }

  const ts = toIsoTimestamp(match[1]);
  const level = normalizeLevel(match[2]);
  if (!ts || !level) {
    return null;
  }

  const tokens = parseKeyValueTokens(match[3]);
  if (!tokens) {
    return null;
  }

  const byKey = new Map<string, string>();
  for (const token of tokens) {
    byKey.set(token.key, token.value);
  }

  const op = byKey.get('op')?.trim() || 'other';
  const trace = byKey.get('trace')?.trim() || '-';
  const err = byKey.get('err')?.trim();
  const remainder = tokens.filter((token) => token.key !== 'op' && token.key !== 'trace' && token.key !== 'err');

  const message =
    err && err.length > 0
      ? err
      : remainder.length > 0
        ? remainder.map(formatTokenValue).join(' ')
        : match[3].trim() || line.trim();

  return {
    ts,
    level,
    op,
    trace,
    service: mapServiceFromOp(op),
    message,
    rawLine: line,
  };
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

function classifyHeuristicLevel(line: string): DiagnosticLevel {
  if (ERROR_LINE_RE.test(line)) {
    return 'ERROR';
  }
  if (WARN_LINE_RE.test(line)) {
    return 'WARN';
  }
  return 'INFO';
}

function parseJsonObject(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function buildSource2JsonMessage(payload: Record<string, unknown>, fallback: string): string {
  const primary =
    stringifyValue(payload.error) || stringifyValue(payload.err) || stringifyValue(payload.message) || stringifyValue(payload.msg);
  return primary || fallback;
}

function buildDockerMessage(payload: Record<string, unknown>): string {
  const msg = stringifyValue(payload.msg) || stringifyValue(payload.message);
  const extras: string[] = [];

  for (const [key, value] of Object.entries(payload)) {
    const lower = key.toLowerCase();
    if (lower === 'time' || lower === 'level' || lower === 'msg' || lower === 'message' || lower === 'op' || lower === 'trace') {
      continue;
    }
    if (
      lower.includes('err') ||
      lower.includes('error') ||
      lower.includes('fail') ||
      lower.includes('panic') ||
      lower.includes('stack')
    ) {
      extras.push(`${key}=${stringifyValue(value)}`);
    }
  }

  if (msg && extras.length > 0) {
    return `${msg} | ${extras.join(' ')}`;
  }
  if (msg) {
    return msg;
  }
  if (extras.length > 0) {
    return extras.join(' ');
  }
  return stringifyValue(payload);
}

function entryMillis(entry: DiagnosticEntry): number {
  const parsed = Date.parse(entry.ts);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function readOpsEntries(logDir: string, notes: string[]): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = [];
  const opsDir = path.join(logDir, 'ops');

  let fileNames: string[] = [];
  try {
    fileNames = readdirSync(opsDir).filter((name) => name.endsWith('.log'));
  } catch (error) {
    notes.push(`ops logs unavailable: ${formatNoteError(error)}`);
    return entries;
  }

  for (const fileName of fileNames) {
    const filePath = path.join(opsDir, fileName);
    let content: string;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch (error) {
      notes.push(`ops file unreadable (${fileName}): ${formatNoteError(error)}`);
      continue;
    }

    let malformed = 0;
    for (const line of splitLines(content)) {
      if (line.trim() === '') {
        continue;
      }

      try {
        const parsed = parseStructuredLine(line);
        if (!parsed) {
          malformed += 1;
          continue;
        }
        entries.push(parsed);
      } catch {
        malformed += 1;
      }
    }

    if (malformed > 0) {
      notes.push(`ops ${fileName}: skipped ${malformed} malformed line(s)`);
    }
  }

  return entries;
}

function readRawCaptureEntries(logDir: string, notes: string[]): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = [];

  for (const source of RAW_CAPTURE_FILES) {
    const filePath = path.join(logDir, source.fileName);
    let fallbackTs = new Date().toISOString();

    try {
      fallbackTs = statSync(filePath).mtime.toISOString();
    } catch {
      // Missing files are expected in many setups.
      continue;
    }

    let content: string;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch (error) {
      notes.push(`stderr file unreadable (${source.fileName}): ${formatNoteError(error)}`);
      continue;
    }

    let malformedStructured = 0;
    for (const line of splitLines(content)) {
      const trimmed = line.trim();
      if (!trimmed || /^---\s*stderr\s*---$/i.test(trimmed)) {
        continue;
      }

      if (STRUCTURED_LINE_RE.test(line)) {
        try {
          const structured = parseStructuredLine(line);
          if (structured) {
            entries.push(structured);
          } else {
            malformedStructured += 1;
          }
        } catch {
          malformedStructured += 1;
        }
        continue;
      }

      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        const payload = parseJsonObject(trimmed);
        if (payload) {
          const ts = toIsoTimestamp(payload.time ?? payload.ts ?? payload.timestamp, fallbackTs) ?? fallbackTs;
          const trace = stringifyValue(payload.trace) || '-';
          const op = stringifyValue(payload.op) || `${source.service}.stderr`;
          entries.push({
            ts,
            level: 'ERROR',
            op,
            trace,
            service: source.service,
            message: buildSource2JsonMessage(payload, trimmed),
            rawLine: line,
          });
          continue;
        }
      }

      entries.push({
        ts: fallbackTs,
        level: classifyHeuristicLevel(line),
        op: `${source.service}.stderr`,
        trace: '-',
        service: source.service,
        message: trimmed,
        rawLine: line,
      });
    }

    if (malformedStructured > 0) {
      notes.push(`stderr ${source.fileName}: skipped ${malformedStructured} malformed structured line(s)`);
    }
  }

  return entries;
}

function buildDockerUnavailableNote(error: unknown): string {
  const pieces: string[] = [];

  if (error instanceof Error) {
    pieces.push(error.message);
  } else {
    pieces.push(stringifyValue(error));
  }

  const maybeExec = error as {
    stdout?: Buffer | string;
    stderr?: Buffer | string;
  };

  const stdout =
    typeof maybeExec.stdout === 'string'
      ? maybeExec.stdout
      : Buffer.isBuffer(maybeExec.stdout)
        ? maybeExec.stdout.toString('utf8')
        : '';
  const stderr =
    typeof maybeExec.stderr === 'string'
      ? maybeExec.stderr
      : Buffer.isBuffer(maybeExec.stderr)
        ? maybeExec.stderr.toString('utf8')
        : '';

  if (stdout.trim()) {
    pieces.push(stdout.trim());
  }
  if (stderr.trim()) {
    pieces.push(stderr.trim());
  }

  return pieces.filter(Boolean).join(' | ');
}

function readDockerHubEntries(sinceHours: number, notes: string[]): { entries: DiagnosticEntry[]; dockerAvailable: boolean } {
  const entries: DiagnosticEntry[] = [];
  const boundedSinceHours = Math.max(1, Math.floor(sinceHours));
  const dockerCmd = `docker logs --since=${boundedSinceHours}h wevibe-hub 2>&1`;

  let output = '';
  try {
    output = execFileSync('sh', ['-lc', dockerCmd], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    notes.push(`docker unavailable: ${buildDockerUnavailableNote(error)}`);
    return { entries, dockerAvailable: false };
  }

  let malformed = 0;
  for (const line of splitLines(output)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      const payload = parseJsonObject(trimmed);
      if (!payload) {
        malformed += 1;
        continue;
      }

      const level = normalizeLevel(stringifyValue(payload.level)) ?? 'INFO';
      const ts = toIsoTimestamp(payload.time, new Date().toISOString()) ?? new Date().toISOString();
      const msg = stringifyValue(payload.msg);

      entries.push({
        ts,
        level,
        op: stringifyValue(payload.op) || msg || 'hub.log',
        trace: stringifyValue(payload.trace) || '-',
        service: 'hub',
        message: buildDockerMessage(payload),
        rawLine: line,
      });
    } catch {
      malformed += 1;
    }
  }

  if (malformed > 0) {
    notes.push(`docker logs: skipped ${malformed} malformed line(s)`);
  }

  return { entries, dockerAvailable: true };
}

function filterSortAndLimit(
  entries: DiagnosticEntry[],
  query: DiagnosticsQuery,
  clearedAt: string | null,
): { matched: number; hiddenByClear: number; entries: DiagnosticEntry[] } {
  const cutoffMs = Date.now() - query.sinceHours * 60 * 60 * 1000;
  const allowedLevels = new Set<DiagnosticLevel>(query.levels);
  const wantedService = query.service?.toLowerCase();

  const filtered = entries.filter((entry) => {
    const tsMs = entryMillis(entry);
    if (tsMs <= 0 || tsMs < cutoffMs) {
      return false;
    }
    if (!allowedLevels.has(entry.level)) {
      return false;
    }
    if (wantedService && entry.service.toLowerCase() !== wantedService) {
      return false;
    }
    return true;
  });

  let visible = filtered;
  let hiddenByClear = 0;

  if (clearedAt && !query.includeCleared) {
    const clearedMs = Date.parse(clearedAt);

    if (!Number.isNaN(clearedMs)) {
      const afterClear: DiagnosticEntry[] = [];
      hiddenByClear = 0;

      for (const entry of filtered) {
        if (entryMillis(entry) > clearedMs) {
          afterClear.push(entry);
        } else {
          hiddenByClear += 1;
        }
      }

      visible = afterClear;
    }
  }

  visible.sort((a, b) => entryMillis(b) - entryMillis(a));

  return {
    matched: visible.length,
    hiddenByClear,
    entries: visible.slice(0, query.limit),
  };
}

export async function GET(request: Request): Promise<Response> {
  const startedAt = Date.now();
  const trace = resolveTraceId(request.headers.get(TRACE_HEADER));
  const query = parseQuery(request.url);

  logOp('dashboard.diagnostics_read', 'info', {
    trace,
    phase: 'entry',
    levels: query.levels,
    limit: query.limit,
    sinceHours: query.sinceHours,
  });

  const notes: string[] = [];

  try {
    const clearedAt = readClearMarker();
    const logDir = resolveLogDir();
    const allEntries: DiagnosticEntry[] = [];

    allEntries.push(...readOpsEntries(logDir, notes));
    allEntries.push(...readRawCaptureEntries(logDir, notes));

    const dockerResult = readDockerHubEntries(query.sinceHours, notes);
    allEntries.push(...dockerResult.entries);

    const seenRawLines = new Set<string>();
    const dedupedEntries: DiagnosticEntry[] = [];
    let duplicateLines = 0;

    for (const entry of allEntries) {
      if (seenRawLines.has(entry.rawLine)) {
        duplicateLines += 1;
        continue;
      }
      seenRawLines.add(entry.rawLine);
      dedupedEntries.push(entry);
    }

    if (duplicateLines > 0) {
      notes.push(`deduped ${duplicateLines} duplicate line(s) (stderr-capture vs ops)`);
    }

    const filtered = filterSortAndLimit(dedupedEntries, query, clearedAt);
    const services = [...new Set(filtered.entries.map((entry) => entry.service))];

    const response: DiagnosticsResponse = {
      entries: filtered.entries,
      matched: filtered.matched,
      dockerAvailable: dockerResult.dockerAvailable,
      services,
      notes,
      clearedAt,
      hiddenByClear: filtered.hiddenByClear,
    };

    logOp('dashboard.diagnostics_read', 'info', {
      trace,
      phase: 'outcome',
      status: 'ok',
      matched: filtered.matched,
      returned: filtered.entries.length,
      docker: dockerResult.dockerAvailable,
      cleared: clearedAt,
      hidden_by_clear: filtered.hiddenByClear,
      dur_ms: Date.now() - startedAt,
    });

    return NextResponse.json(response);
  } catch (error) {
    const errText = formatError(error);
    const errNote = `diagnostics route error: ${formatNoteError(error)}`;
    notes.push(errNote);

    logOp('dashboard.diagnostics_read', 'error', {
      trace,
      phase: 'outcome',
      status: 'error',
      err: errText,
      dur_ms: Date.now() - startedAt,
    });

    const response: DiagnosticsResponse = {
      entries: [],
      matched: 0,
      dockerAvailable: false,
      services: [],
      notes,
      clearedAt: null,
      hiddenByClear: 0,
    };

    return NextResponse.json(response, { status: 200 });
  }
}
