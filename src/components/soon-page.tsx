"use client";

import { Pager, usePageSize } from "@/components/ui/pager";

export function SoonPage({ title }: { title: string }) {
  const [pageSize, setPageSize] = usePageSize(`soon-${title}`, 25);
  return (
    <div>
      <div className="pagehead">
        <div className="desc">Halaman ini memakai pola Master Data yang sama begitu modulnya dibuat.</div>
        <div className="actions">
          <button className="btn pri" disabled>Tambah</button>
          <button className="btn" disabled>Impor</button>
          <button className="btn" disabled>Hapus massal</button>
          <button className="btn" disabled>Export</button>
        </div>
      </div>
      <div className="card soonbox">
        <h2>Segera hadir</h2>
        <div className="mut">Halaman <b>{title}</b> akan dirancang di tahap berikutnya.</div>
      </div>
      <div className="tablecard mt">
        <table><thead><tr><th>Data</th></tr></thead><tbody><tr><td className="empty">Belum ada data {title}.</td></tr></tbody></table>
        <Pager page={0} pageSize={pageSize} total={0} shown={0} onPage={() => undefined} onPageSize={setPageSize} />
      </div>
    </div>
  );
}
