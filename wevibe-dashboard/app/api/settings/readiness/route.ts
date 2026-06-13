import { NextResponse } from 'next/server';
import { getCertifiedReadiness } from '@/lib/provider-readiness';
import { loadSettings } from '@/lib/settings';

export const dynamic = 'force-dynamic';

export async function GET() {
  const settings = loadSettings();
  const readiness = await getCertifiedReadiness(settings);
  return NextResponse.json(readiness);
}
