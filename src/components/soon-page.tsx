export function SoonPage({ title }: { title: string }) {
  return (
    <div>
      <div className="pagehead">
        <div className="desc">Halaman ini memakai pola Master Data yang sama begitu modulnya dibuat.</div>
        <div className="actions">
          <button className="btn pri" disabled>Tambah</button>
          <button className="btn" disabled>Import</button>
          <button className="btn" disabled>Hapus massal</button>
          <button className="btn" disabled>Export</button>
        </div>
      </div>
      <div className="card soonbox">
        <h2>Segera hadir</h2>
        <div className="mut">Halaman <b>{title}</b> akan dirancang di tahap berikutnya.</div>
      </div>
    </div>
  );
}
