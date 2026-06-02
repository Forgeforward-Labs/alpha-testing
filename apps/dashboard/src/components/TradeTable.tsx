import type { TradeRecord } from '@/types';

interface Props {
  trades: TradeRecord[];
}

function fmt(ts: number) {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function TradeTable({ trades }: Props) {
  if (trades.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted">No trades yet</p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-muted border-b border-border">
            <th className="pb-2 text-left font-normal">Time</th>
            <th className="pb-2 text-left font-normal">Side</th>
            <th className="pb-2 text-right font-normal">Price</th>
            <th className="pb-2 text-right font-normal">Filled</th>
            <th className="pb-2 text-right font-normal">Notional</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => (
            <tr key={t.at} className="border-b border-border/40 hover:bg-card/60">
              <td className="py-1.5 text-muted">{fmt(t.at)}</td>
              <td className={`py-1.5 font-semibold uppercase ${t.side === 'buy' ? 'text-accent' : 'text-red-400'}`}>
                {t.side}
              </td>
              <td className="py-1.5 text-right">{Number(t.price).toFixed(4)}</td>
              <td className="py-1.5 text-right">{Number(t.filledAmount).toFixed(4)}</td>
              <td className="py-1.5 text-right">${t.notional.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
