// Shared contract for the Diagnostics error surface (:3001 contributor dashboard).
// Consumed by BOTH the reader API (app/api/errors/route.ts) and the Diagnostics
// page (app/(dashboard)/diagnostics/page.tsx). Defined once here so the two
// sides never drift. See wevibe-meta/workspace/docs/LOGGING-CONVENTION.md for the
// underlying R-37 log line format this parses.

export type DiagnosticLevel = 'ERROR' | 'WARN' | 'INFO';

/**
 * One parsed diagnostic entry, sourced from either a structured R-37 ops log
 * line, a raw stderr-capture file, or a dockerized service's JSON stdout.
 */
export interface DiagnosticEntry {
  /** ISO-8601 timestamp of the log line (best-effort; falls back to file mtime). */
  ts: string;
  /** Normalized level. Raw/heuristic sources map to ERROR/WARN/INFO. */
  level: DiagnosticLevel;
  /** Operation name (structured `op=`) or a synthetic label for raw sources. */
  op: string;
  /** Correlation id (structured `trace=`), or '-' when absent. */
  trace: string;
  /** Source service this entry came from (e.g. 'mcp', 'hub', 'dashboard', 'umbral', 'client', 'plugin'). */
  service: string;
  /** Full human-readable error/message text (the `err=` value when present, else the line body). */
  message: string;
  /**
   * The EXACT original line as captured — this is the copy payload Walter pastes
   * back to the manager. Never truncated.
   */
  rawLine: string;
}

/** Response shape returned by GET /api/errors. */
export interface DiagnosticsResponse {
  entries: DiagnosticEntry[];
  /** Total entries matched (after the clear marker filter) before the `limit` cap was applied. */
  matched: number;
  /** Whether the docker-logs hub merge ran (false = docker unavailable / skipped). */
  dockerAvailable: boolean;
  /** Distinct service tags present in `entries` (for the page's filter chips). */
  services: string[];
  /** Non-fatal notes (e.g. "docker CLI not found", "N files unreadable"). */
  notes: string[];
  /**
   * Current diagnostics clear marker (ISO-8601) or null if never cleared. When
   * set, GET /api/errors hides entries with ts <= clearedAt by default. This is
   * a VIEW filter only — NOTHING is deleted; the logfiles stay intact.
   */
  clearedAt: string | null;
  /**
   * Count of entries that matched the query (level/service/window) but were
   * HIDDEN because their ts <= clearedAt. Lets the UI say "N errors hidden by
   * clear at <ts> — show all" (honest: hidden, not deleted). 0 when includeCleared.
   */
  hiddenByClear: number;
}

/** Parsed, validated query params for GET /api/errors. */
export interface DiagnosticsQuery {
  /** Levels to include. Default ['ERROR', 'WARN']. */
  levels: DiagnosticLevel[];
  /** Max entries returned (newest-first). Default 500. */
  limit: number;
  /** Only include entries newer than now - sinceHours. Default 24. */
  sinceHours: number;
  /** Optional service filter (single service tag); undefined = all. */
  service?: string;
  /**
   * When true, IGNORE the clear marker and return the full history (nothing is
   * ever deleted). Default false. Query param `?includeCleared=true`.
   */
  includeCleared: boolean;
}

/**
 * State of the diagnostics "clear" marker, returned by GET /api/errors/clear and
 * POST /api/errors/clear. The marker is a single latest ISO timestamp persisted
 * server-side (in wevibe-meta/.logs) so the page, the modal, and reloads agree.
 */
export interface DiagnosticsClearState {
  /** The latest clear timestamp (ISO-8601), or null if never cleared. */
  cleared_at: string | null;
}

export const DIAGNOSTICS_DEFAULTS = {
  levels: ['ERROR', 'WARN'] as DiagnosticLevel[],
  limit: 500,
  sinceHours: 24,
} as const;

/** All service tags the reader can emit; drives the page's filter chips. */
export const DIAGNOSTIC_SERVICES = [
  'mcp',
  'hub',
  'dashboard',
  'client',
  'umbral',
  'plugin',
  'other',
] as const;

/** Payload POSTed by the browser client-error capture to /api/client-errors. */
export interface ClientErrorPayload {
  /** Error message (scrubbed of secrets before send). */
  message: string;
  /** Error stack (scrubbed), when available. */
  stack?: string;
  /** Page URL where the error occurred (query string stripped). */
  url?: string;
  /**
   * How it was caught. 'connection' = an MCP/SSE transport failure captured by
   * the mcp-client (which never fires window.onerror), surfaced by the topbar.
   */
  kind: 'onerror' | 'unhandledrejection' | 'boundary' | 'connection';
}

/**
 * A captured live connection (MCP/SSE transport) error. Retained on the mcp
 * client and surfaced by the topbar indicator + connection-error modal so the
 * exact failing URL is copyable in-app instead of buried in the browser network
 * console. Stated truthfully (R-36): the URL + an honest "unreachable" message
 * (+ optional /health probe result) — NOT a fabricated browser network string.
 */
export interface ConnectionError {
  /** Human-readable, honest detail including the failing URL. */
  message: string;
  /** The exact URL that failed (e.g. http://127.0.0.1:4451/sse). */
  url: string;
  /** ISO-8601 timestamp when the error was captured. */
  at: string;
}
