'use client';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import type { EquityPoint } from '@/types';

interface Props {
  data: EquityPoint[];
}

function fmt(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function EquityChart({ data }: Props) {
  if (data.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted text-sm">
        Waiting for data…
      </div>
    );
  }

  const min = Math.min(...data.map((d) => d.value)) * 0.999;
  const max = Math.max(...data.map((d) => d.value)) * 1.001;
  const isUp = data[data.length - 1].value >= data[0].value;

  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={isUp ? '#22c55e' : '#ef4444'} stopOpacity={0.25} />
            <stop offset="95%" stopColor={isUp ? '#22c55e' : '#ef4444'} stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis
          dataKey="at"
          tickFormatter={fmt}
          tick={{ fill: '#6b7280', fontSize: 10 }}
          axisLine={false}
          tickLine={false}
          minTickGap={60}
        />
        <YAxis
          domain={[min, max]}
          tick={{ fill: '#6b7280', fontSize: 10 }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v: number) => v.toFixed(2)}
          width={52}
        />
        <Tooltip
          contentStyle={{ background: '#111115', border: '1px solid #1e1e26', borderRadius: 6 }}
          labelStyle={{ color: '#6b7280', fontSize: 11 }}
          itemStyle={{ color: '#e5e7eb', fontSize: 12 }}
          labelFormatter={(v: number) => fmt(v)}
          formatter={(v: number) => [v.toFixed(4), 'Equity']}
        />
        <Area
          type="monotone"
          dataKey="value"
          stroke={isUp ? '#22c55e' : '#ef4444'}
          strokeWidth={2}
          fill="url(#eq)"
          dot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
