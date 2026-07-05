import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { resolveLogDir } from '@/lib/logger';

const CLEAR_MARKER_FILE = '.diagnostics-cleared-at';

function clearMarkerPath(): string {
  return path.join(resolveLogDir(), CLEAR_MARKER_FILE);
}

export function readClearMarker(): string | null {
  try {
    const marker = readFileSync(clearMarkerPath(), 'utf8').trim();
    if (marker.length === 0) {
      return null;
    }

    const parsed = new Date(marker);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }

    return marker;
  } catch {
    return null;
  }
}

export function writeClearMarker(): string {
  const clearedAt = new Date().toISOString();
  const logDir = resolveLogDir();

  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  writeFileSync(path.join(logDir, CLEAR_MARKER_FILE), clearedAt, 'utf8');
  return clearedAt;
}
