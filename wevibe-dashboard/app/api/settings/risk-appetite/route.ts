import { NextResponse } from 'next/server';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CONFIG_PATH = join(homedir(), '.wevibe', 'plugin-config.json');

export async function GET() {
  try {
    if (!existsSync(CONFIG_PATH)) return NextResponse.json({ risk_appetite: 'neutral' });
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    return NextResponse.json({ risk_appetite: parsed?.risk_appetite === 'lowest' ? 'lowest' : 'neutral' });
  } catch {
    return NextResponse.json({ risk_appetite: 'neutral' });
  }
}

export async function PUT(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const value = (body as { risk_appetite?: unknown }).risk_appetite;
    if (value !== 'lowest' && value !== 'neutral') {
      return NextResponse.json({ error: 'risk_appetite must be "lowest" or "neutral"' }, { status: 400 });
    }
    const dir = join(homedir(), '.wevibe');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    let current: Record<string, unknown> = {};
    if (existsSync(CONFIG_PATH)) {
      try { current = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')); } catch { current = {}; }
    }
    writeFileSync(CONFIG_PATH, `${JSON.stringify({ ...current, risk_appetite: value }, null, 2)}\n`, 'utf-8');
    return NextResponse.json({ status: 'ok', risk_appetite: value });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
