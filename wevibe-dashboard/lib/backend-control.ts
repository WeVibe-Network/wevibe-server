import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BackendActionResult, BackendStatus } from '@/lib/backend-types';
import { logOp, resolveLogDir } from '@/lib/logger';

const BACKEND_PORT = 4451;
const BACKEND_HEALTH_URL = `http://127.0.0.1:${BACKEND_PORT}/health`;
const PORT_4451_LISTENERS_CMD = `lsof -ti tcp:${BACKEND_PORT} -sTCP:LISTEN`;
const STATUS_LSOF_TIMEOUT_MS = 5_000;
const STATUS_HEALTH_TIMEOUT_MS = 3_000;
const START_HEALTH_WAIT_SECONDS = 15;
const PORT_KILL_WAIT_MS = 1_000;

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  try {
    return String(error);
  } catch {
    return 'unknown error';
  }
}

function errorFullText(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseFirstPid(output: string): number | null {
  for (const line of output.split(/\r?\n/)) {
    const parsed = Number.parseInt(line.trim(), 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return null;
}

function readPort4451ListenerPids(): number[] {
  try {
    const raw = execFileSync('sh', ['-lc', PORT_4451_LISTENERS_CMD], {
      encoding: 'utf8',
      timeout: STATUS_LSOF_TIMEOUT_MS,
    });

    const found = raw
      .split(/\r?\n/)
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid): pid is number => Number.isInteger(pid) && pid > 0);

    return [...new Set(found)];
  } catch {
    return [];
  }
}

function hasWorkspaceMarkers(current: string): boolean {
  try {
    return (
      existsSync(path.join(current, 'wevibe-mcp', 'dist', 'dashboard-server.js')) &&
      existsSync(path.join(current, 'wevibe-meta'))
    );
  } catch {
    return false;
  }
}

function findWorkspaceRootFrom(startDir: string): string | null {
  try {
    let current = path.resolve(startDir);

    while (true) {
      if (hasWorkspaceMarkers(current)) {
        return current;
      }

      const parent = path.dirname(current);
      if (parent === current) {
        return null;
      }

      current = parent;
    }
  } catch {
    return null;
  }
}

function resolveNodeCommand(): string {
  try {
    const exeName = path.basename(process.execPath).toLowerCase();
    if (exeName === 'node' || exeName === 'node.exe') {
      return process.execPath;
    }
  } catch {
    // best-effort only
  }

  return 'node';
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function summarizeHealthDetail(response: Response): Promise<string> {
  const fallback = `HTTP ${response.status}`;

  let bodyText = '';
  try {
    bodyText = await response.text();
  } catch {
    return fallback;
  }

  const trimmed = bodyText.trim();
  if (trimmed === '') {
    return fallback;
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isRecord(parsed)) {
      const status = typeof parsed.status === 'string' ? parsed.status : undefined;
      const server = typeof parsed.server === 'string' ? parsed.server : undefined;

      if (status && server) {
        return `${status} (${server})`;
      }
      if (status) {
        return status;
      }
      if (server) {
        return server;
      }
    }
  } catch {
    // no-op; fallback below
  }

  return fallback;
}

export function resolveWorkspaceRoot(): string {
  const fromCwd = findWorkspaceRootFrom(process.cwd());
  if (fromCwd) {
    return fromCwd;
  }

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const fromModuleDir = findWorkspaceRootFrom(moduleDir);
  if (fromModuleDir) {
    return fromModuleDir;
  }

  const fallback = path.dirname(path.dirname(resolveLogDir()));
  logOp('dashboard.backend_root_resolve', 'warn', {
    trace: '-',
    phase: 'fallback',
    detail: `workspace markers not found; using fallback: ${fallback}`,
  });
  return fallback;
}

export async function getBackendStatus(): Promise<BackendStatus> {
  let pid: number | null = null;
  try {
    const raw = execFileSync('sh', ['-lc', PORT_4451_LISTENERS_CMD], {
      encoding: 'utf8',
      timeout: STATUS_LSOF_TIMEOUT_MS,
    });
    pid = parseFirstPid(raw);
  } catch {
    pid = null;
  }

  const running = pid !== null;
  if (!running) {
    return {
      running: false,
      pid: null,
      healthy: false,
      detail: 'Not listening on :4451',
    };
  }

  try {
    const response = await fetch(BACKEND_HEALTH_URL, {
      signal: AbortSignal.timeout(STATUS_HEALTH_TIMEOUT_MS),
    });
    const detail = await summarizeHealthDetail(response);

    return {
      running,
      pid,
      healthy: response.ok,
      detail,
    };
  } catch (error) {
    return {
      running,
      pid,
      healthy: false,
      detail: errorMessage(error),
    };
  }
}

export async function killPort4451(): Promise<{ killed: number[]; detail: string }> {
  const listeners = readPort4451ListenerPids();
  if (listeners.length === 0) {
    return { killed: [], detail: 'already free' };
  }

  const killed = new Set<number>();
  const termErrors: string[] = [];

  for (const pid of listeners) {
    try {
      process.kill(pid, 'SIGTERM');
      killed.add(pid);
    } catch (error) {
      termErrors.push(`${pid}:${errorMessage(error)}`);
    }
  }

  await sleep(PORT_KILL_WAIT_MS);

  const stillListeningAfterTerm = readPort4451ListenerPids();
  const killErrors: string[] = [];

  if (stillListeningAfterTerm.length > 0) {
    for (const pid of stillListeningAfterTerm) {
      try {
        process.kill(pid, 'SIGKILL');
        killed.add(pid);
      } catch (error) {
        killErrors.push(`${pid}:${errorMessage(error)}`);
      }
    }
    await sleep(PORT_KILL_WAIT_MS);
  }

  const stillListening = readPort4451ListenerPids();
  const detailParts: string[] = [];

  if (stillListening.length === 0) {
    if (stillListeningAfterTerm.length === 0) {
      detailParts.push(`stopped ${listeners.length} listener(s) with SIGTERM`);
    } else {
      detailParts.push(`stopped ${listeners.length} listener(s); escalated to SIGKILL for ${stillListeningAfterTerm.length}`);
    }
  } else {
    detailParts.push(`listeners still present on :4451 after kill attempt: ${stillListening.join(',')}`);
  }

  if (termErrors.length > 0) {
    detailParts.push(`SIGTERM errors: ${termErrors.join('; ')}`);
  }
  if (killErrors.length > 0) {
    detailParts.push(`SIGKILL errors: ${killErrors.join('; ')}`);
  }

  return {
    killed: [...killed],
    detail: detailParts.join(' | '),
  };
}

export async function startBackend(trace: string): Promise<BackendActionResult> {
  let logPath: string | undefined;

  try {
    const killResult = await killPort4451();
    logOp('dashboard.backend_start', 'info', {
      trace,
      phase: 'prekill',
      detail: killResult.detail,
      killed: killResult.killed,
    });

    const root = resolveWorkspaceRoot();
    const bin = path.join(root, 'wevibe-mcp', 'dist', 'dashboard-server.js');
    const cwd = path.join(root, 'wevibe-mcp');

    if (!existsSync(bin)) {
      const detail = `binary not found: ${bin}`;
      logOp('dashboard.backend_start', 'error', {
        trace,
        phase: 'spawn_check',
        status: 'error',
        detail,
      });

      return {
        ok: false,
        status: await getBackendStatus(),
        detail,
      };
    }

    const logDir = resolveLogDir();
    mkdirSync(logDir, { recursive: true });
    logPath = path.join(logDir, 'dashboard-mcp.log');

    const fd = openSync(logPath, 'a');
    try {
      const nodeCommand = resolveNodeCommand();
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        WEVIBE_HUB_URL: 'http://localhost:4440',
        WEVIBE_DASHBOARD_PORT: '4451',
        WEVIBE_BIND_HOST: '127.0.0.1',
        WEVIBE_OLLAMA_URL: 'http://localhost:11434',
        WEVIBE_GUARD_BIN: path.join(root, 'wevibe-guard', 'target', 'release', 'wevibe-guard'),
        WEVIBE_UMBRAL_SIDECAR_BIN: path.join(root, 'wevibe-umbral', 'target', 'release', 'wevibe-umbral'),
      };

      const child = spawn(nodeCommand, ['dist/dashboard-server.js'], {
        cwd,
        env,
        detached: true,
        stdio: ['ignore', fd, fd],
      });
      child.unref();
    } finally {
      closeSync(fd);
    }

    for (let attempt = 0; attempt < START_HEALTH_WAIT_SECONDS; attempt += 1) {
      await sleep(1_000);
      const status = await getBackendStatus();
      if (status.running && status.healthy) {
        return {
          ok: true,
          status,
          detail: 'started',
          logPath,
        };
      }
    }

    return {
      ok: false,
      status: await getBackendStatus(),
      detail: 'started but /health did not become ok within 15s (see log)',
      logPath,
    };
  } catch (error) {
    const detail = errorMessage(error);
    logOp('dashboard.backend_start', 'error', {
      trace,
      phase: 'exception',
      status: 'error',
      err: errorFullText(error),
    });

    return {
      ok: false,
      status: await getBackendStatus(),
      detail,
      logPath,
    };
  }
}

export async function stopBackend(): Promise<BackendActionResult> {
  const killResult = await killPort4451();
  return {
    ok: true,
    status: await getBackendStatus(),
    detail: killResult.detail,
  };
}

export async function restartBackend(trace: string): Promise<BackendActionResult> {
  await stopBackend();
  return startBackend(trace);
}
