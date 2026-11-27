"use client";

import Link from "next/link";
import { Fragment, useState } from "react";
import { Pager, useClientPage } from "@/components/ui/pager";
import { TableShell } from "@/components/ui/feedback";
import type { MarketingLineRow } from "@/lib/db/types";
import { contributionBeforeHpp, feeCoverageRatio, storeProfit } from "@/lib/marketing/allocate";
import { formatDay, numId, rp } from "@/lib/format";

export type ProfitRow = {
  key: string;
  orders: number;
  qty: number;
  net: number;
  gross?: number;
  hpp?: number;
  fee?: number;
  marketing?: number;
  miss?: boolean;
  mpNet?: number;
  mpCovered?: number;
  returnQty?: number;
  returnNet?: number;
  promo?: boolean;
  anomaly?: boolean;
  children?: ProfitRow[];
};

type Ready = ProfitRow & {
  hpp: number;
  fee: number;
  marketing: number;
  profit: number;
  contribution: number;
  margin: number | null;
  coverage: number | null;
  perOrder: number | null;
  avgPrice: number | null;
  hppUnit: number | null;
};

function ready(row: ProfitRow, withMarketing: boolean): Ready {
  const hpp = row.hpp ?? 0;
  const fee = row.fee ?? 0;
  const marketing = withMarketing ? row.marketing ?? 0 : 0;
  const profit = storeProfit(row.net, hpp, fee, marketing);
  const qty = row.qty || 0;
  return {
    ...row,
    hpp,
    fee,
    marketing,
    profit,
    contribution: contributionBeforeHpp(row.net, fee, marketing),
    margin: row.net ? profit / row.net : null,
    coverage: row.mpNet == null ? null : feeCoverageRatio(row.mpNet, row.mpCovered ?? 0),
    perOrder: row.orders ? profit / row.orders : null,
    avgPrice: qty ? row.net / qty : null,
    hppUnit: qty ? hpp / qty : null,
  };
}

function pct(value: number | null, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits).replace(".", ",")}%`;
}

function rate(part: number, net: number): string {
  if (!net) return "—";
  return pct(part / net);
}

function money(value: number) {
  return <span className={value < 0 ? "dn" : undefined}>{rp(value)}</span>;
}

function change(current: number, previous: number | undefined): { text: string; good: boolean } | null {
  if (previous == null || !previous) return null;
  const delta = ((current - previous) / Math.abs(previous)) * 100;
  return { text: `${delta >= 0 ? "▲" : "▼"} ${Math.abs(delta).toFixed(1).replace(".", ",")}%`, good: delta >= 0 };
}

export function CompletenessBanner({
  mpNet,
  mpCovered,
  marketingThrough,
  periodTo,
  returnsOrders,
  returnsNet,
  includeReturns,
}: {
  mpNet?: number;
  mpCovered?: number;
  marketingThrough?: string | null;
  periodTo: string;
  returnsOrders?: number;
  returnsNet?: number;
  includeReturns: boolean;
}) {
  const lines: string[] = [];
  if (mpNet != null) {
    const coverage = feeCoverageRatio(mpNet, mpCovered ?? 0);
    if (coverage === 0) lines.push("Biaya platform periode ini belum tercakup. Profit terlihat lebih tinggi dari seharusnya dan ditandai sementara.");
    else if (coverage != null && coverage < 0.999) lines.push(`Biaya platform baru ${pct(coverage, 0)} tercakup dari revenue marketplace. Profit dengan cakupan di bawah 100% ditandai sementara.`);
  }
  if (marketingThrough && periodTo && marketingThrough < periodTo) {
    lines.push(`Marketing s/d ${formatDay(marketingThrough)}, belum sampai akhir periode. Profit masih kurang potongan iklan.`);
  }
  if (returnsOrders) {
    lines.push(includeReturns
      ? `Retur dihitung di dalam angka: ${numId(returnsOrders)} pesanan, ${rp(returnsNet ?? 0)}.`
      : `Retur tidak masuk angka utama: ${numId(returnsOrders)} pesanan, ${rp(returnsNet ?? 0)}. Nyalakan Sertakan retur untuk menghitungnya.`);
  }
  if (!lines.length) return null;
  return (
    <div className="warnbox mt">
      {lines.map((line) => <div key={line}>{line}</div>)}
    </div>
  );
}

export function WaterfallTable({
  title,
  hint,
  rows,
  compareRows,
  loading,
  withMarketing,
  showUnits,
  showReturns,
  expandable,
  marketingThroughByStore,
  periodTo,
}: {
  title: string;
  hint?: string;
  rows: ProfitRow[];
  compareRows?: ProfitRow[];
  loading: boolean;
  withMarketing: boolean;
  showUnits?: boolean;
  showReturns?: boolean;
  expandable?: boolean;
  marketingThroughByStore?: Record<string, string>;
  periodTo?: string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<"profit" | "net" | "margin" | "qty">("profit");
  const prepared = rows.map((row) => ready(row, withMarketing));
  const sorted = [...prepared].sort((a, b) => {
    const av = sortKey === "net" ? a.net : sortKey === "qty" ? a.qty : sortKey === "margin" ? (a.margin ?? -999) : a.profit;
    const bv = sortKey === "net" ? b.net : sortKey === "qty" ? b.qty : sortKey === "margin" ? (b.margin ?? -999) : b.profit;
    const worstFirst = sortKey === "profit" || sortKey === "margin";
    return worstFirst ? av - bv : bv - av;
  });
  const page = useClientPage(sorted, `profit-${title}-${sortKey}`, title.includes("Produk") ? 10 : 25);
  const prior = new Map((compareRows ?? []).map((row) => [row.key, ready(row, withMarketing)]));
  const showCompare = compareRows != null;
  const cols = 10 + (withMarketing ? 1 : 0) + (showUnits ? 2 : 0) + (showReturns ? 1 : 0) + (showCompare ? 1 : 0);
  return (
    <div className="tablecard mt">
      <div className="th3">
        <b>{title}</b>
        {hint ? <small className="mut">{hint}</small> : null}
        <div className="seg sm" style={{ marginLeft: "auto" }}>
          {([["profit", "Profit"], ["margin", "Margin"], ["net", "Revenue"], ["qty", "Qty"]] as const).map(([key, label]) => (
            <button key={key} className={sortKey === key ? "on" : ""} onClick={() => setSortKey(key)}>{label}</button>
          ))}
        </div>
      </div>
      <TableShell loading={loading}>
        <div className="tscroll">
          <table className="small">
            <thead>
              <tr>
                <th>{title.replace("Penjualan per ", "")}</th>
                <th className="n">Pesanan</th>
                <th className="n">Qty</th>
                {showUnits ? <th className="n">Harga/unit</th> : null}
                <th className="n">Revenue</th>
                <th className="n">HPP</th>
                {showUnits ? <th className="n">HPP/unit</th> : null}
                <th className="n">Biaya platform</th>
                {withMarketing ? <th className="n">Marketing</th> : null}
                <th className="n">Kontribusi sebelum HPP</th>
                <th className="n">Profit bersih</th>
                <th className="n">Margin</th>
                <th className="n">Profit/pesanan</th>
                {showReturns ? <th className="n">Retur</th> : null}
                {showCompare ? <th className="n">vs periode</th> : null}
              </tr>
            </thead>
            <tbody>
              {page.shown.flatMap((row) => {
                const before = prior.get(row.key);
                const delta = change(row.profit, before?.profit);
                const marginPts = before?.margin != null && row.margin != null ? (row.margin - before.margin) * 100 : null;
                const through = marketingThroughByStore?.[row.key];
                const shortAds = Boolean(through && periodTo && through < periodTo);
                const provisional = (row.coverage != null && row.coverage < 0.999) || shortAds;
                const cells = (
                  <tr key={row.key || "kosong"}>
                    <td>
                      {expandable && row.children?.length ? (
                        <button type="button" className="btn sm ghost" onClick={() => setOpen((value) => value === row.key ? null : row.key)}>{open === row.key ? "▾" : "▸"} {row.key || "—"}</button>
                      ) : row.key || "—"}
                      {row.miss ? <div className="pill p-warn">HPP belum lengkap</div> : null}
                      {row.coverage != null && row.coverage < 0.999 ? <div className="pill p-warn">Biaya platform baru {pct(row.coverage, 0)} tercakup</div> : null}
                      {shortAds ? <div className="pill p-warn">Marketing s/d {formatDay(through)}</div> : null}
                      {provisional ? <div className="pill p-gray">Sementara</div> : null}
                      {row.promo ? <div className="pill p-pur">Biaya promosi barang</div> : null}
                      {row.anomaly ? <div className="pill p-bad">HPP di atas harga jual</div> : null}
                    </td>
                    <td className="n">{numId(row.orders)}</td>
                    <td className="n">{numId(row.qty)}</td>
                    {showUnits ? <td className="n">{row.avgPrice == null ? "—" : rp(row.avgPrice)}</td> : null}
                    <td className="n">{rp(row.net)}</td>
                    <td className="n">{rp(row.hpp)}</td>
                    {showUnits ? <td className="n">{row.hppUnit == null ? "—" : rp(row.hppUnit)}</td> : null}
                    <td className="n">{rp(row.fee)}<div className="mut">{rate(row.fee, row.net)}</div></td>
                    {withMarketing ? <td className="n">{rp(row.marketing)}<div className="mut">{rate(row.marketing, row.net)}</div></td> : null}
                    <td className="n">{money(row.contribution)}</td>
                    <td className="n">{money(row.profit)}</td>
                    <td className="n">{pct(row.margin)}</td>
                    <td className="n">{row.perOrder == null ? "—" : money(row.perOrder)}</td>
                    {showReturns ? <td className="n">{numId(row.returnQty ?? 0)}<div className="mut">{rp(row.returnNet ?? 0)}</div></td> : null}
                    {showCompare ? <td className="n">{delta ? <span className={delta.good ? "up" : "dn"}>{delta.text}</span> : "—"}{marginPts == null ? null : <div className="mut">margin {marginPts >= 0 ? "+" : ""}{marginPts.toFixed(1).replace(".", ",")} pt</div>}</td> : null}
                  </tr>
                );
                if (!expandable || open !== row.key) return [cells];
                const kids = (row.children ?? []).map((child) => ready(child, withMarketing)).sort((a, b) => a.profit - b.profit);
                return [cells, ...kids.map((child) => (
                  <tr key={`${row.key}-${child.key}`}>
                    <td style={{ paddingLeft: 22 }}>{child.key || "—"}
                      {child.miss ? <div className="pill p-warn">HPP belum lengkap</div> : null}
                      {child.coverage != null && child.coverage < 0.999 ? <div className="pill p-warn">Biaya platform baru {pct(child.coverage, 0)} tercakup</div> : null}
                      {(child.coverage != null && child.coverage < 0.999) ? <div className="pill p-gray">Sementara</div> : null}
                    </td>
                    <td className="n">{numId(child.orders)}</td>
                    <td className="n">{numId(child.qty)}</td>
                    {showUnits ? <td /> : null}
                    <td className="n">{rp(child.net)}</td>
                    <td className="n">{rp(child.hpp)}</td>
                    {showUnits ? <td /> : null}
                    <td className="n">{rp(child.fee)}<div className="mut">{rate(child.fee, child.net)}</div></td>
                    {withMarketing ? <td className="n">{rp(child.marketing)}<div className="mut">{rate(child.marketing, child.net)}</div></td> : null}
                    <td className="n">{money(child.contribution)}</td>
                    <td className="n">{money(child.profit)}</td>
                    <td className="n">{pct(child.margin)}</td>
                    <td className="n">{child.perOrder == null ? "—" : money(child.perOrder)}</td>
                    {showReturns ? <td /> : null}
                    {showCompare ? <td /> : null}
                  </tr>
                ))];
              })}
              {!page.shown.length ? <tr><td colSpan={cols} className="mut">Tidak ada data</td></tr> : null}
            </tbody>
          </table>
        </div>
        <Pager page={page.page} pageSize={page.pageSize} total={page.total} shown={page.shown.length} onPage={page.setPage} onPageSize={page.setPageSize} />
      </TableShell>
    </div>
  );
}

export type LossRankRow = {
  id: string;
  store: string;
  channel: string;
  profit: number;
  margin: number | null;
  orders: number;
  net: number;
  provisional: boolean;
};

export function LossRank({ title, hint, rows, loading, href }: {
  title: string;
  hint: string;
  rows: LossRankRow[];
  loading: boolean;
  href: (row: LossRankRow) => string;
}) {
  const page = useClientPage(rows, `loss-${title}`, 10);
  return (
    <div className="tablecard mt">
      <div className="th3"><b>{title}</b> <small className="mut">{hint}</small></div>
      <TableShell loading={loading}>
        <div className="tscroll">
          <table className="small cards">
            <thead><tr><th>Toko</th><th>Channel</th><th className="n">Pesanan</th><th className="n">Revenue</th><th className="n">Profit bersih</th><th className="n">Margin</th></tr></thead>
            <tbody>
              {page.shown.map((row) => (
                <tr key={row.id}>
                  <td data-label="Toko"><Link href={href(row)}>{row.store || "—"}</Link>{row.provisional ? <div className="pill p-gray">Sementara</div> : null}</td>
                  <td data-label="Channel"><Link href={href(row)}>{row.channel || "Semua channel"}</Link></td>
                  <td data-label="Pesanan" className="n">{numId(row.orders)}</td>
                  <td data-label="Revenue" className="n">{rp(row.net)}</td>
                  <td data-label="Profit bersih" className="n">{money(row.profit)}</td>
                  <td data-label="Margin" className="n">{pct(row.margin)}</td>
                </tr>
              ))}
              {!page.shown.length ? <tr><td colSpan={6} className="mut">Tidak ada toko atau channel dengan profit bersih di bawah nol pada periode ini.</td></tr> : null}
            </tbody>
          </table>
        </div>
        <Pager page={page.page} pageSize={page.pageSize} total={page.total} shown={page.shown.length} onPage={page.setPage} onPageSize={page.setPageSize} />
      </TableShell>
    </div>
  );
}

export function ProductLossList({ title, hint, rows, loading, href, empty }: {
  title: string;
  hint: string;
  rows: Ready[];
  loading: boolean;
  href: (row: Ready) => string;
  empty: string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const page = useClientPage(rows, `plist-${title}`, 10);
  return (
    <div className="tablecard mt">
      <div className="th3"><b>{title}</b> <small className="mut">{hint}</small></div>
      <TableShell loading={loading}>
        <div className="tscroll">
          <table className="small cards">
            <thead><tr><th>SKU</th><th className="n">Qty</th><th className="n">Revenue</th><th className="n">HPP</th><th className="n">Biaya platform</th><th className="n">Profit</th><th className="n">Margin</th></tr></thead>
            <tbody>
              {page.shown.map((row) => (
                <Fragment key={row.key}>
                  <tr>
                    <td data-label="SKU">
                      <Link href={href(row)}>{row.key}</Link>
                      {row.miss ? <div className="pill p-warn">HPP belum lengkap</div> : null}
                      {row.promo ? <div className="pill p-pur">Biaya promosi barang</div> : null}
                      {row.anomaly ? <div className="pill p-bad">HPP di atas harga jual</div> : null}
                      {row.children?.length ? <button type="button" className="btn sm ghost" onClick={() => setOpen((value) => value === row.key ? null : row.key)}>{open === row.key ? "Tutup channel" : "Margin per channel"}</button> : null}
                    </td>
                    <td data-label="Qty" className="n">{numId(row.qty)}</td>
                    <td data-label="Revenue" className="n">{rp(row.net)}</td>
                    <td data-label="HPP" className="n">{rp(row.hpp)}</td>
                    <td data-label="Biaya platform" className="n">{rp(row.fee)}</td>
                    <td data-label="Profit" className="n">{money(row.profit)}</td>
                    <td data-label="Margin" className="n">{pct(row.margin)}</td>
                  </tr>
                  {open === row.key ? (row.children ?? []).map((child) => {
                    const item = ready(child, false);
                    return (
                      <tr key={`${row.key}-${item.key}`}>
                        <td style={{ paddingLeft: 22 }}>{item.key}</td>
                        <td className="n">{numId(item.qty)}</td>
                        <td className="n">{rp(item.net)}</td>
                        <td className="n">{rp(item.hpp)}</td>
                        <td className="n">{rp(item.fee)}</td>
                        <td className="n">{money(item.profit)}</td>
                        <td className="n">{pct(item.margin)}</td>
                      </tr>
                    );
                  }) : null}
                </Fragment>
              ))}
              {!page.shown.length ? <tr><td colSpan={7} className="mut">{empty}</td></tr> : null}
            </tbody>
          </table>
        </div>
        <Pager page={page.page} pageSize={page.pageSize} total={page.total} shown={page.shown.length} onPage={page.setPage} onPageSize={page.setPageSize} />
      </TableShell>
    </div>
  );
}

export function MarketingBreakdown({ rows, loading }: { rows: MarketingLineRow[]; loading: boolean }) {
  const page = useClientPage(rows, "mkt-lines", 10);
  return (
    <div className="tablecard mt">
      <div className="th3"><b>Rincian marketing</b> <small className="mut">Meta Ads, CPAS, dan Shopee Ads masuk ke Shopee. TikTok Ads dibagi ke TikTok dan Tokopedia menurut revenue.</small></div>
      <TableShell loading={loading}>
        <div className="tscroll">
          <table className="small cards">
            <thead><tr><th>Toko</th><th>Platform</th><th>Dialokasikan ke</th><th className="n">Spend</th><th className="n">ROAS platform</th><th className="n">ROAS riil</th><th className="n">Marketing % revenue</th><th className="n">ROAS impas</th></tr></thead>
            <tbody>
              {page.shown.map((row) => {
                const platformRoas = row.adsRevenue != null && row.spend ? row.adsRevenue / row.spend : null;
                const realRoas = row.spend ? row.targetNet / row.spend : null;
                const after = row.targetNet - row.targetHpp - row.targetFee;
                const breakEven = row.targetNet > 0 && after > 0 ? row.targetNet / after : null;
                return (
                  <tr key={`${row.store}-${row.platform}`}>
                    <td data-label="Toko">{row.store}</td>
                    <td data-label="Platform">{row.platform}</td>
                    <td data-label="Channel">{row.channels.join(" + ") || "—"}</td>
                    <td data-label="Spend" className="n">{rp(row.spend)}</td>
                    <td data-label="ROAS platform" className="n">{platformRoas == null ? "—" : `${platformRoas.toFixed(1).replace(".", ",")}x`}</td>
                    <td data-label="ROAS riil" className="n">{realRoas == null ? "—" : `${realRoas.toFixed(1).replace(".", ",")}x`}</td>
                    <td data-label="Marketing" className="n">{rate(row.spend, row.targetNet)}</td>
                    <td data-label="ROAS impas" className="n">{breakEven == null ? "sudah rugi sebelum iklan" : `${breakEven.toFixed(1).replace(".", ",")}x`}</td>
                  </tr>
                );
              })}
              {!page.shown.length ? <tr><td colSpan={8} className="mut">Tidak ada marketing pada periode ini.</td></tr> : null}
            </tbody>
          </table>
        </div>
        <Pager page={page.page} pageSize={page.pageSize} total={page.total} shown={page.shown.length} onPage={page.setPage} onPageSize={page.setPageSize} />
      </TableShell>
    </div>
  );
}

export function asReady(row: ProfitRow): Ready {
  return ready(row, false);
}
