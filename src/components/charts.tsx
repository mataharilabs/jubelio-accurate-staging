"use client";

import { rp, rpCompact } from "@/lib/format";

const PAL = ["#4f46e5", "#0ea5e9", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6", "#84cc16", "#f97316"];

export function BarChart({
  labels,
  series,
  line,
}: {
  labels: string[];
  series: { name: string; values: number[]; color: string }[];
  line?: { name: string; values: number[]; color: string };
}) {
  const W = 720;
  const H = 250;
  const pl = 62;
  const pr = 12;
  const pt = 14;
  const pb = 34;
  const iw = W - pl - pr;
  const ih = H - pt - pb;
  const max = Math.max(1, ...series.flatMap((item) => item.values)) * 1.08;
  const n = Math.max(labels.length, 1);
  const gw = iw / n;
  const bw = Math.min(46, (gw * 0.72) / Math.max(series.length, 1));
  const lineMax = line ? Math.max(1, ...line.values) * 1.15 : 1;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img">
        {[0, 1, 2, 3, 4].map((i) => {
          const y = pt + ih - (ih * i) / 4;
          return (
            <g key={i}>
              <line x1={pl} x2={W - pr} y1={y} y2={y} stroke="#eef0f5" />
              <text x={pl - 8} y={y + 4} textAnchor="end" fontSize="11" fill="#8a91a3">{rpCompact(max * i / 4)}</text>
            </g>
          );
        })}
        {labels.map((label, i) => {
          const x0 = pl + gw * i + (gw - bw * series.length) / 2;
          return (
            <g key={label + i}>
              {series.map((item, j) => {
                const h = (ih * (item.values[i] || 0)) / max;
                return <rect key={item.name} x={x0 + j * bw + 1} y={pt + ih - h} width={Math.max(bw - 2, 1)} height={Math.max(0, h)} rx="3" fill={item.color}><title>{`${label} · ${item.name}: ${rp(item.values[i] || 0)}`}</title></rect>;
              })}
              <text x={pl + gw * i + gw / 2} y={H - 12} textAnchor="middle" fontSize="11" fill="#5b6375">{label}</text>
            </g>
          );
        })}
        {line ? (
          <polyline
            fill="none"
            stroke={line.color}
            strokeWidth="2"
            strokeDasharray="4 3"
            points={line.values.map((value, i) => `${pl + gw * i + gw / 2},${pt + ih - (ih * value) / lineMax}`).join(" ")}
          />
        ) : null}
      </svg>
      <div className="legend">
        {series.map((item) => <span key={item.name}><i style={{ background: item.color }} />{item.name}</span>)}
        {line ? <span><i style={{ background: line.color }} />{line.name} (garis)</span> : null}
      </div>
    </div>
  );
}

export function HBars({ items, qty = false }: { items: { label: string; value: number; color?: string }[]; qty?: boolean }) {
  const max = Math.max(1, ...items.map((item) => item.value));
  return (
    <table>
      <tbody>
        {items.map((item, index) => (
          <tr key={item.label}>
            <td className="small" style={{ width: "38%", border: 0 }}>{item.label}</td>
            <td style={{ border: 0 }}>
              <div style={{ height: 16, borderRadius: 4, background: item.color || PAL[index % PAL.length], width: `${Math.max(1, (item.value / max) * 100)}%` }} />
            </td>
            <td className="n small" style={{ border: 0, width: 96 }}>{qty ? `${Math.round(item.value).toLocaleString("id-ID")} pcs` : rpCompact(item.value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Donut({ items }: { items: { label: string; value: number; color: string }[] }) {
  const total = items.reduce((sum, item) => sum + item.value, 0) || 1;
  let angle = -Math.PI / 2;
  const cx = 90;
  const cy = 90;
  const r = 78;
  const ri = 48;
  const paths = items.map((item) => {
    const next = angle + (item.value / total) * Math.PI * 2;
    const large = next - angle > Math.PI ? 1 : 0;
    const p = (a: number, radius: number) => [cx + radius * Math.cos(a), cy + radius * Math.sin(a)];
    const [x0, y0] = p(angle, r);
    const [x1, y1] = p(next - 1e-4, r);
    const [x2, y2] = p(next - 1e-4, ri);
    const [x3, y3] = p(angle, ri);
    const d = `M${x0},${y0}A${r},${r} 0 ${large} 1 ${x1},${y1}L${x2},${y2}A${ri},${ri} 0 ${large} 0 ${x3},${y3}Z`;
    angle = next;
    return <path key={item.label} d={d} fill={item.color}><title>{`${item.label}: ${rp(item.value)}`}</title></path>;
  });
  return (
    <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
      <svg viewBox="0 0 180 180" width="160" style={{ flex: "none" }}>
        {paths}
        <text x="90" y="86" textAnchor="middle" fontSize="11" fill="#8a91a3">Total</text>
        <text x="90" y="104" textAnchor="middle" fontSize="13" fontWeight="700">{rpCompact(total)}</text>
      </svg>
      <table style={{ flex: 1 }}>
        <tbody>
          {items.map((item) => (
            <tr key={item.label}>
              <td className="nowrap" style={{ border: 0 }}><i className="pdot" style={{ background: item.color }} /> {item.label}</td>
              <td className="n small" style={{ border: 0 }}>{rpCompact(item.value)}</td>
              <td className="n small mut" style={{ border: 0 }}>{((item.value / total) * 100).toFixed(1)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const CHART_PAL = PAL;
