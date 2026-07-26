'use client';

import { useEffect, useState } from 'react';
import Card from '@/components/ui/card';
import ClientTime from '@/components/ui/client-time';
import Spinner from '@/components/ui/spinner';
import {
  getPendingCallbacks,
  getRecallHealth,
  type PendingCallbacksResponse,
  type RecallHealth,
} from '@/lib/hub-client';
import simBenchmark from '@/lib/sim-benchmark.json';
import { useDashboardState } from '@/lib/use-dashboard-state';

type WindowId = 'all' | '24h' | '7d';
type BandToken = 'wv-green' | 'wv-amber' | 'wv-red' | 'wv-faint';
type DataSourceTag = 'live proxy' | 'live feedback' | 'target band (tunable)';
type SimCell = (typeof simBenchmark.cells)[number];

const WINDOW_OPTIONS: ReadonlyArray<{ id: WindowId; label: string; hours?: number }> = [
  { id: 'all', label: 'All time' },
  { id: '24h', label: 'Last 24h', hours: 24 },
  { id: '7d', label: 'Last 7d', hours: 168 },
];

const EMPTY_HEALTH: RecallHealth = {
  window_hours: null,
  query_count: 0,
  avg_returned: 0,
  avg_candidates: 0,
  zero_injection_pct: 0,
  contested_pct: 0,
  disposition: {
    returned: 0,
    below_floor: 0,
    over_budget_unsampled: 0,
  },
  score_separation: {
    avg_returned_score: null,
    avg_below_floor_score: null,
    gap: null,
  },
  feedback: {
    serve_count: 0,
    denial_count: 0,
    serve_denial_ratio: null,
  },
  pending_serve_backlog: 0,
};

const EMPTY_PENDING_CALLBACKS: PendingCallbacksResponse = {
  buckets: {
    gt_1h: 0,
    gt_24h: 0,
    gt_7d: 0,
  },
  items: [],
};

const BAND_STYLES: Record<BandToken, { dot: string; bar: string; value: string }> = {
  'wv-green': {
    dot: 'bg-wv-green',
    bar: 'bg-[rgba(54,211,153,0.36)]',
    value: 'text-wv-green',
  },
  'wv-amber': {
    dot: 'bg-wv-amber',
    bar: 'bg-[rgba(255,178,85,0.40)]',
    value: 'text-wv-amber',
  },
  'wv-red': {
    dot: 'bg-wv-red',
    bar: 'bg-[rgba(255,107,107,0.38)]',
    value: 'text-wv-red',
  },
  'wv-faint': {
    dot: 'bg-wv-faint',
    bar: 'bg-wv-line',
    value: 'text-wv-faint',
  },
};

const DATA_SOURCE_STYLES: Record<DataSourceTag, string> = {
  'live proxy': 'text-wv-cyan bg-[rgba(52,220,240,0.12)] border-[rgba(52,220,240,0.4)]',
  'live feedback': 'text-wv-green bg-[rgba(54,211,153,0.12)] border-[rgba(54,211,153,0.4)]',
  'target band (tunable)': 'text-wv-amber bg-[rgba(255,178,85,0.12)] border-[rgba(255,178,85,0.4)]',
};

function bandColor(
  value: number | null,
  rules: {
    green: (next: number) => boolean;
    amber: (next: number) => boolean;
  },
): BandToken {
  if (value === null || !Number.isFinite(value)) {
    return 'wv-faint';
  }
  if (rules.green(value)) {
    return 'wv-green';
  }
  if (rules.amber(value)) {
    return 'wv-amber';
  }
  return 'wv-red';
}

function formatFixed(value: number | null | undefined, digits: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  return value.toFixed(digits);
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  return `${value.toFixed(1)}%`;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatWindowLabel(hours: number | null | undefined): string {
  if (hours === null || hours === undefined) {
    return 'All time';
  }
  if (hours === 24) {
    return 'Last 24h';
  }
  if (hours === 168) {
    return 'Last 7d';
  }
  return `Last ${hours}h`;
}

function dispositionPct(value: number, total: number): string {
  if (total <= 0) {
    return '0.0%';
  }
  return `${((value / total) * 100).toFixed(1)}%`;
}

function formatAgeCompact(ageSeconds: number): string {
  if (!Number.isFinite(ageSeconds) || ageSeconds <= 0) {
    return '0m';
  }

  if (ageSeconds < 60) {
    return '<1m';
  }

  const totalMinutes = Math.floor(ageSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }

  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) {
    return minutes > 0 ? `${totalHours}h ${minutes}m` : `${totalHours}h`;
  }

  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

function Gauge({
  label,
  value,
  token,
  healthyBand,
  detail,
}: {
  label: string;
  value: string;
  token: BandToken;
  healthyBand: string;
  detail?: string;
}) {
  const style = BAND_STYLES[token];

  return (
    <div className="rounded-lg border border-wv-line bg-wv-panel-2 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] font-mono uppercase tracking-[0.08em] text-wv-dim">{label}</p>
        <span className={`h-2.5 w-2.5 rounded-full ${style.dot}`} />
      </div>
      <p className={`mt-2 text-xl font-semibold ${style.value}`}>{value}</p>
      <div className={`mt-2 h-1.5 rounded-full ${style.bar}`} />
      <p className="mt-2 text-xs text-wv-dim">{healthyBand}</p>
      {detail ? <p className="mt-1 text-xs text-wv-faint">{detail}</p> : null}
    </div>
  );
}

function BenchmarkRow({
  title,
  cell,
  highlighted,
}: {
  title: string;
  cell: SimCell | undefined;
  highlighted?: boolean;
}) {
  return (
    <div
      className={`grid grid-cols-[160px_repeat(5,minmax(0,1fr))] gap-3 border-t border-wv-line px-3 py-3 text-sm ${
        highlighted ? 'bg-[rgba(124,92,255,0.08)]' : ''
      }`}
    >
      <div>
        <p className="font-mono text-wv-text">{cell ? `${cell.id} · ${cell.label}` : `${title} unavailable`}</p>
        <p className="mt-0.5 text-xs text-wv-dim">{title}</p>
      </div>
      <span className="font-mono text-wv-text">{formatFixed(cell?.metrics.recall_at_1, 3)}</span>
      <span className="font-mono text-wv-text">{formatFixed(cell?.metrics.recall_at_5, 3)}</span>
      <span className="font-mono text-wv-text">{formatFixed(cell?.metrics.mrr, 3)}</span>
      <span className="font-mono text-wv-text">{formatFixed(cell?.metrics.ndcg_at_5, 3)}</span>
      <span className="font-mono text-wv-text">{formatFixed(cell?.metrics.mean_separation, 3)}</span>
    </div>
  );
}

export default function RecallInspectPage() {
  const { isLeader, activeOrg, loading } = useDashboardState();
  const [selectedWindow, setSelectedWindow] = useState<WindowId>('all');
  const [health, setHealth] = useState<RecallHealth | null>(null);
  const [pendingCallbacks, setPendingCallbacks] = useState<PendingCallbacksResponse | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [pendingCallbacksError, setPendingCallbacksError] = useState<string | null>(null);

  const selectedWindowOption = WINDOW_OPTIONS.find((option) => option.id === selectedWindow) ?? WINDOW_OPTIONS[0];

  useEffect(() => {
    if (!activeOrg?.org_id || !isLeader) {
      setHealth(null);
      setPendingCallbacks(null);
      setHealthError(null);
      setPendingCallbacksError(null);
      setHealthLoading(false);
      return;
    }

    let cancelled = false;
    setHealthLoading(true);
    setHealthError(null);
    setPendingCallbacksError(null);

    void Promise.allSettled([
      getRecallHealth(activeOrg.org_id, selectedWindowOption.hours),
      getPendingCallbacks(activeOrg.org_id),
    ])
      .then(([healthResult, pendingCallbacksResult]) => {
        if (cancelled) {
          return;
        }

        if (healthResult.status === 'fulfilled') {
          setHealth(healthResult.value);
        } else {
          setHealth(null);
          setHealthError(
            healthResult.reason instanceof Error
              ? healthResult.reason.message
              : String(healthResult.reason),
          );
        }

        if (pendingCallbacksResult.status === 'fulfilled') {
          setPendingCallbacks(pendingCallbacksResult.value);
        } else {
          setPendingCallbacks(null);
          setPendingCallbacksError(
            pendingCallbacksResult.reason instanceof Error
              ? pendingCallbacksResult.reason.message
              : String(pendingCallbacksResult.reason),
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setHealthLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeOrg?.org_id, isLeader, selectedWindowOption.hours]);

  const recallHealth = health ?? EMPTY_HEALTH;
  const pendingCallbacksData = pendingCallbacks ?? EMPTY_PENDING_CALLBACKS;
  const pendingCallbacksUnavailable = pendingCallbacks === null && pendingCallbacksError !== null;
  const noData = recallHealth.query_count === 0;

  const gt1hValue = pendingCallbacksUnavailable ? null : pendingCallbacksData.buckets.gt_1h;
  const gt24hValue = pendingCallbacksUnavailable ? null : pendingCallbacksData.buckets.gt_24h;
  const gt7dValue = pendingCallbacksUnavailable ? null : pendingCallbacksData.buckets.gt_7d;

  const gt1hToken = bandColor(gt1hValue, {
    green: (value) => value === 0,
    amber: (value) => value > 0,
  });
  const gt24hToken = bandColor(gt24hValue, {
    green: (value) => value === 0,
    amber: () => false,
  });
  const gt7dToken = bandColor(gt7dValue, {
    green: (value) => value === 0,
    amber: () => false,
  });

  const pendingItems = pendingCallbacksData.items ?? [];

  const floorGap = noData ? null : recallHealth.score_separation.gap;
  const floorToken = bandColor(floorGap, {
    green: (value) => value >= 0.15,
    amber: (value) => value >= 0.05 && value < 0.15,
  });

  const restraintValue = noData ? null : recallHealth.avg_returned;
  const restraintToken = bandColor(restraintValue, {
    green: (value) => value <= 3,
    amber: (value) => value > 3 && value <= 5,
  });

  const zeroInjectionValue = noData ? null : recallHealth.zero_injection_pct;
  const zeroInjectionToken = bandColor(zeroInjectionValue, {
    green: (value) => value <= 50,
    amber: (value) => value > 50 && value <= 75,
  });

  const contestedValue = noData ? null : recallHealth.contested_pct;
  const contestedToken = bandColor(contestedValue, {
    green: (value) => value < 15,
    amber: (value) => value >= 15 && value < 30,
  });

  const ratioValue = !noData && recallHealth.feedback.denial_count > 0
    ? recallHealth.feedback.serve_denial_ratio
    : null;
  const ratioToken = bandColor(ratioValue, {
    green: (value) => value >= 3,
    amber: (value) => value >= 1 && value < 3,
  });
  const ratioDisplay = recallHealth.feedback.denial_count === 0
    ? 'no denials yet'
    : ratioValue === null
      ? '—'
      : `${formatFixed(ratioValue, 2)}x`;

  const dispositionTotal =
    recallHealth.disposition.returned +
    recallHealth.disposition.below_floor +
    recallHealth.disposition.over_budget_unsampled;

  const dispositionSegments = [
    {
      key: 'returned',
      label: 'returned',
      count: recallHealth.disposition.returned,
      color: 'bg-wv-green',
    },
    {
      key: 'below_floor',
      label: 'below_floor',
      count: recallHealth.disposition.below_floor,
      color: 'bg-wv-red',
    },
    {
      key: 'over_budget_unsampled',
      label: 'over_budget_unsampled',
      count: recallHealth.disposition.over_budget_unsampled,
      color: 'bg-wv-amber',
    },
  ] as const;

  const baselineCell = simBenchmark.cells.find((cell) => cell.id === 'C0');
  const canonicalCell = simBenchmark.cells.find((cell) => cell.id === 'C3');
  const otherCells = simBenchmark.cells.filter((cell) => cell.id !== 'C0' && cell.id !== 'C3');

  const dataKeyRows: ReadonlyArray<{
    metric: string;
    sources: DataSourceTag[];
    healthyRange: string;
    meaning: string;
  }> = [
    {
      metric: 'Floor fidelity (score gap)',
      sources: ['live proxy', 'target band (tunable)'],
      healthyRange: 'Green ≥0.15 · Amber 0.05..0.15 · Red <0.05',
      meaning: 'Tracks separation between returned and below-floor scores; wider gap means cleaner floor behavior.',
    },
    {
      metric: 'Restraint (avg injected)',
      sources: ['live proxy', 'target band (tunable)'],
      healthyRange: 'Green ≤3 · Amber >3..5 · Red >5',
      meaning: 'Measures average returned memories per recall; high values can indicate budget pressure or weak pruning.',
    },
    {
      metric: 'Zero-injection rate',
      sources: ['live proxy', 'target band (tunable)'],
      healthyRange: 'Green ≤50% · Amber >50..75% · Red >75%',
      meaning: 'Some zero-injection is healthy; very high rates suggest a too-aggressive floor or sparse corpus.',
    },
    {
      metric: 'Contested rate',
      sources: ['live proxy', 'target band (tunable)'],
      healthyRange: 'Green <15% · Amber 15..30% · Red ≥30%',
      meaning: 'Shows how often return decisions are contested; sustained high values signal unstable selection boundaries.',
    },
    {
      metric: 'Serve:denial ratio',
      sources: ['live feedback', 'target band (tunable)'],
      healthyRange: 'Green ≥3 · Amber 1..<3 · Red <1 (gray when no denials yet)',
      meaning: 'Feedback ratio from live serving outcomes; low values indicate frequent downstream denial relative to serves.',
    },
    {
      metric: 'Retrieval breadth (avg candidates)',
      sources: ['live proxy'],
      healthyRange: 'Informational only (no target band)',
      meaning: 'Candidate pool breadth before final return; use with pending serve backlog to monitor load and queue pressure.',
    },
  ];

  if (loading) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold text-wv-text">Recall Health</h1>
        <Card className="p-5">
          <Spinner text="Loading dashboard state…" className="text-sm" />
        </Card>
      </div>
    );
  }

  if (!isLeader) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold text-wv-text">Recall Health</h1>
        <Card className="p-5">
          <p className="text-sm text-wv-amber">Recall Health is leader-only.</p>
        </Card>
      </div>
    );
  }

  if (!activeOrg) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold text-wv-text">Recall Health</h1>
        <Card className="p-5">
          <p className="text-sm text-wv-amber">Select an org.</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-wv-text">Recall Health</h1>

      <Card className="p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-mono uppercase tracking-[0.08em] text-wv-dim">Window</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {WINDOW_OPTIONS.map((option) => {
                const selected = option.id === selectedWindow;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setSelectedWindow(option.id)}
                    className={`rounded-pill border px-3 py-1.5 text-xs font-mono transition ${
                      selected
                        ? 'border-[rgba(124,92,255,0.55)] bg-[rgba(124,92,255,0.14)] text-wv-violet'
                        : 'border-wv-line text-wv-dim hover:border-wv-line-2 hover:text-wv-text'
                    }`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-wv-dim">
              Active window: {formatWindowLabel(recallHealth.window_hours ?? selectedWindowOption.hours ?? null)}
            </p>
          </div>

          <div className="rounded-lg border border-wv-line bg-wv-panel-2 px-4 py-3 lg:text-right">
            <p className="text-xs font-mono uppercase tracking-[0.08em] text-wv-dim">Queries in window</p>
            <p className="mt-1 text-3xl font-semibold text-wv-cyan">{formatCount(recallHealth.query_count)}</p>
            {healthLoading ? (
              <Spinner text="Refreshing health…" className="mt-1 text-xs" />
            ) : (
              <p className="mt-1 text-xs text-wv-faint">Last loaded for {formatWindowLabel(recallHealth.window_hours)}</p>
            )}
          </div>
        </div>
      </Card>

      {healthError ? (
        <Card className="border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] p-4">
          <p className="text-sm text-wv-red">{healthError}</p>
        </Card>
      ) : null}

      {!healthLoading && noData && !healthError ? (
        <Card className="p-4">
          <p className="text-sm text-wv-amber">No recall queries logged yet — run recall sessions to populate health.</p>
        </Card>
      ) : null}

      <Card className="p-5">
        <h2 className="text-lg font-semibold text-wv-text">Live System Health</h2>
        <p className="mt-1 text-sm text-wv-dim">At-a-glance operational proxies from live recall traffic.</p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <Gauge
            label="Floor fidelity (score gap)"
            value={formatFixed(floorGap, 3)}
            token={floorToken}
            healthyBand="Healthy band: ≥0.15 (amber 0.05..0.15)"
            detail={`avg returned ${formatFixed(noData ? null : recallHealth.score_separation.avg_returned_score, 3)} · avg below-floor ${formatFixed(noData ? null : recallHealth.score_separation.avg_below_floor_score, 3)}`}
          />
          <Gauge
            label="Restraint (avg injected)"
            value={formatFixed(restraintValue, 2)}
            token={restraintToken}
            healthyBand="Healthy band: ≤3 (amber >3..5)"
          />
          <Gauge
            label="Zero-injection rate"
            value={formatPercent(zeroInjectionValue)}
            token={zeroInjectionToken}
            healthyBand="Healthy band: ≤50% (amber >50..75%)"
          />
          <Gauge
            label="Contested rate"
            value={formatPercent(contestedValue)}
            token={contestedToken}
            healthyBand="Healthy band: <15% (amber 15..30%)"
          />
          <Gauge
            label="Serve:denial ratio"
            value={ratioDisplay}
            token={ratioToken}
            healthyBand="Healthy band: ≥3 (amber 1..<3; gray when no denials yet)"
            detail={`serve ${formatCount(noData ? 0 : recallHealth.feedback.serve_count)} · denial ${formatCount(noData ? 0 : recallHealth.feedback.denial_count)}`}
          />
          <Gauge
            label="Retrieval breadth (avg candidates)"
            value={formatFixed(noData ? null : recallHealth.avg_candidates, 2)}
            token="wv-faint"
            healthyBand="Informational only (no target band)"
            detail={`pending serve backlog ${formatCount(noData ? 0 : recallHealth.pending_serve_backlog)}`}
          />
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="text-lg font-semibold text-wv-text">Pending callbacks</h2>
        <p className="mt-1 text-sm text-wv-dim">
          Delivered recall memories that still have no serve, denial-note, or report decision.
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <Gauge
            label="Pending &gt;1h"
            value={gt1hValue === null ? '—' : formatCount(gt1hValue)}
            token={gt1hToken}
            healthyBand="Healthy band: 0 (amber when &gt;0)"
          />
          <Gauge
            label="Pending &gt;24h"
            value={gt24hValue === null ? '—' : formatCount(gt24hValue)}
            token={gt24hToken}
            healthyBand="Healthy band: 0 (red when &gt;0)"
          />
          <Gauge
            label="Pending &gt;7d"
            value={gt7dValue === null ? '—' : formatCount(gt7dValue)}
            token={gt7dToken}
            healthyBand="Healthy band: 0 (red when &gt;0)"
          />
        </div>

        {pendingCallbacksError ? (
          <p className="mt-3 text-xs text-wv-amber">Pending callbacks unavailable: {pendingCallbacksError}</p>
        ) : null}

        <details className="mt-4 rounded-lg border border-wv-line bg-wv-panel-2 p-3">
          <summary className="cursor-pointer text-sm text-wv-dim">Recent pending ({pendingItems.length})</summary>
          <div className="mt-3 space-y-2">
            {pendingItems.length === 0 ? (
              <p className="text-xs text-wv-faint">No pending callbacks.</p>
            ) : (
              pendingItems.map((item, index) => (
                <div
                  key={`${item.member_pubkey}-${item.memory_content_hash}-${item.delivered_at}-${index}`}
                  className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-wv-line bg-wv-panel px-3 py-2"
                >
                  <div className="space-y-1 text-xs">
                    <p className="text-wv-dim">
                      member{' '}
                      <span className="font-mono text-wv-text" title={item.member_pubkey}>
                        {`${item.member_pubkey.slice(0, 12)}…`}
                      </span>
                    </p>
                    <p className="text-wv-dim">
                      memory{' '}
                      <span className="font-mono text-wv-text" title={item.memory_content_hash}>
                        {`${item.memory_content_hash.slice(0, 12)}…`}
                      </span>
                    </p>
                    <p className="text-wv-faint">
                      delivered{' '}
                      <ClientTime value={item.delivered_at} mode="datetime-compact" fallback={item.delivered_at} />
                    </p>
                  </div>
                  <p className="text-xs font-mono text-wv-amber">age {formatAgeCompact(item.age_seconds)}</p>
                </div>
              ))
            )}
          </div>
        </details>
      </Card>

      <Card className="p-5">
        <h2 className="text-lg font-semibold text-wv-text">Candidate Disposition</h2>
        <p className="mt-1 text-sm text-wv-dim">Distribution of returned vs gated/unsampled candidates.</p>

        <div className="mt-4 overflow-hidden rounded-pill border border-wv-line bg-wv-panel-2">
          {dispositionTotal === 0 ? (
            <div className="h-4 w-full bg-wv-panel-2" />
          ) : (
            <div className="flex h-4 w-full">
              {dispositionSegments.map((segment) => (
                <div
                  key={segment.key}
                  className={segment.color}
                  style={{ width: `${(segment.count / dispositionTotal) * 100}%` }}
                />
              ))}
            </div>
          )}
        </div>

        <div className="mt-4 grid gap-2 md:grid-cols-3">
          {dispositionSegments.map((segment) => (
            <div key={`${segment.key}-legend`} className="rounded-lg border border-wv-line bg-wv-panel-2 p-3">
              <div className="flex items-center gap-2">
                <span className={`h-2.5 w-2.5 rounded-full ${segment.color}`} />
                <p className="text-xs font-mono uppercase tracking-[0.06em] text-wv-dim">{segment.label}</p>
              </div>
              <p className="mt-1 text-sm font-mono text-wv-text">
                {formatCount(segment.count)}{' '}
                <span className="text-wv-dim">({dispositionPct(segment.count, dispositionTotal)})</span>
              </p>
            </div>
          ))}
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-wv-text">Sim Benchmark (validated target)</h2>
            <p className="mt-1 text-sm text-wv-dim">
              Offline eval with ground truth — the validated target the engine was tuned to. NOT a live comparison.
            </p>
          </div>
          <p className="text-xs text-wv-faint">
            Snapshot:{' '}
            <ClientTime
              value={simBenchmark.generated_at}
              mode="datetime-compact"
              fallback={simBenchmark.generated_at}
            />
          </p>
        </div>

        <div className="mt-4 overflow-x-auto rounded-lg border border-wv-line">
          <div className="min-w-[780px]">
            <div className="grid grid-cols-[160px_repeat(5,minmax(0,1fr))] gap-3 bg-wv-panel-2 px-3 py-2 text-[11px] font-mono uppercase tracking-[0.07em] text-wv-dim">
              <span>Cell</span>
              <span>Recall@1</span>
              <span>Recall@5</span>
              <span>MRR</span>
              <span>nDCG@5</span>
              <span>mean_sep</span>
            </div>
            <BenchmarkRow title="Prod baseline" cell={baselineCell} />
            <BenchmarkRow title="Canonical target" cell={canonicalCell} highlighted />
          </div>
        </div>

        {otherCells.length > 0 ? (
          <details className="mt-4 rounded-lg border border-wv-line bg-wv-panel-2 p-3">
            <summary className="cursor-pointer text-sm text-wv-dim">Show other sim cells ({otherCells.length})</summary>
            <div className="mt-3 space-y-2">
              {otherCells.map((cell) => (
                <div key={cell.id} className="rounded-lg border border-wv-line bg-wv-panel px-3 py-2 text-xs">
                  <p className="font-mono text-wv-text">{cell.id} · {cell.label}</p>
                  <p className="mt-1 text-wv-dim">
                    Recall@1 {formatFixed(cell.metrics.recall_at_1, 3)} · Recall@5 {formatFixed(cell.metrics.recall_at_5, 3)} · MRR {formatFixed(cell.metrics.mrr, 3)} · nDCG@5 {formatFixed(cell.metrics.ndcg_at_5, 3)} · mean_sep {formatFixed(cell.metrics.mean_separation, 3)}
                  </p>
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </Card>

      <Card className="p-5">
        <h2 className="text-lg font-semibold text-wv-text">Data Key</h2>
        <p className="mt-2 rounded-lg border border-wv-line bg-wv-panel-2 p-3 text-sm text-wv-dim">
          The sim has ground truth (real Recall@k); the live system does NOT. Live metrics are behavioral proxies — this
          page shows whether the deployed system is operating in the regime the sim validated, not a head-to-head
          Recall@k. Floor fidelity (live score gap) is the closest cousin of the sim&apos;s mean_separation, but they are
          computed differently and on different scales — do not read them as the same number.
        </p>

        <div className="mt-4 space-y-3">
          {dataKeyRows.map((row) => (
            <div key={row.metric} className="rounded-lg border border-wv-line bg-wv-panel-2 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold text-wv-text">{row.metric}</p>
                <div className="flex flex-wrap gap-2">
                  {row.sources.map((source) => (
                    <span
                      key={`${row.metric}-${source}`}
                      className={`inline-flex items-center rounded-pill border px-2 py-0.5 font-mono text-[11px] ${DATA_SOURCE_STYLES[source]}`}
                    >
                      {source}
                    </span>
                  ))}
                </div>
              </div>
              <p className="mt-2 text-xs text-wv-dim">Healthy range: {row.healthyRange}</p>
              <p className="mt-1 text-xs text-wv-faint">{row.meaning}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
