'use client';
import { useBotState } from '@/hooks/useBotState';
import { EquityChart } from '@/components/EquityChart';
import { TradeTable } from '@/components/TradeTable';

function uptime(startedAt: number) {
  const s = Math.floor((Date.now() - startedAt) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${color ?? 'text-gray-100'}`}>
        {value}
      </p>
      {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
    </div>
  );
}

export default function Dashboard() {
  const { state, connected } = useBotState();

  const parts = (state?.symbol ?? '').split(':');
  const base = parts[0] ?? 'BASE';
  const quote = parts[1] ?? 'QUOTE';

  const series = state?.equitySeries ?? [];
  const initialEquity = series[0]?.value ?? 0;
  const currentEquity = series.at(-1)?.value ?? 0;
  const pnl = currentEquity - initialEquity;
  const pnlPct = initialEquity > 0 ? (pnl / initialEquity) * 100 : 0;
  const pnlColor = pnl >= 0 ? 'text-accent' : 'text-red-400';

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span
            className={`h-2.5 w-2.5 rounded-full ${connected ? 'bg-accent shadow-[0_0_6px_#22c55e]' : 'bg-red-500'}`}
          />
          <h1 className="text-lg font-semibold tracking-wide text-gray-100">
            TRADING BOT
          </h1>
          {state && (
            <div className="flex gap-2">
              <span className="rounded bg-card border border-border px-2 py-0.5 text-xs text-muted">
                {state.symbol}
              </span>
              <span className="rounded bg-card border border-border px-2 py-0.5 text-xs text-muted capitalize">
                {state.strategy}
              </span>
              <span className="rounded bg-card border border-border px-2 py-0.5 text-xs text-muted">
                {state.executionMode}
              </span>
            </div>
          )}
        </div>
        {state && (
          <span className="text-xs text-muted">
            Uptime {uptime(state.startedAt)}
          </span>
        )}
      </div>

      {/* Stats row */}
      {state ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard
            label="Session P&L"
            value={`${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`}
            sub={`${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`}
            color={pnlColor}
          />
          <StatCard
            label="Volume"
            value={`$${state.totalVolume.toFixed(2)}`}
            sub={`${state.totalTrades} trades`}
          />
          <StatCard
            label={base}
            value={state.baseBalance.toFixed(4)}
            sub="base balance"
          />
          <StatCard
            label={quote}
            value={state.quoteBalance.toFixed(2)}
            sub="quote balance"
          />
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted">
          {connected ? 'Loading…' : 'Waiting for bot — set METRICS_PORT and restart'}
        </div>
      )}

      {/* Chart + trades */}
      {state && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="mb-3 text-xs font-medium text-muted uppercase tracking-wider">
              Equity Curve
            </p>
            <div className="h-56">
              <EquityChart data={state.equitySeries} />
            </div>
          </div>

          <div className="rounded-lg border border-border bg-card p-4">
            <p className="mb-3 text-xs font-medium text-muted uppercase tracking-wider">
              Recent Trades
            </p>
            <TradeTable trades={state.recentTrades.slice(0, 15)} />
          </div>
        </div>
      )}

      {/* Status line */}
      {state?.statusLine && (
        <div className="rounded border border-border bg-card px-4 py-2 text-xs text-muted">
          {state.statusLine}
        </div>
      )}
    </div>
  );
}
