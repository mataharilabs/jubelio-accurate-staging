import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-md px-6 py-24">
      <h1 className="text-2xl font-semibold">Halaman tidak ada</h1>
      <p className="mt-2 text-sm text-muted">Tautan itu tidak mengarah ke batch atau menu yang dikenal.</p>
      <Link href="/" className="mt-4 inline-block text-sm text-primary">Kembali ke dasbor</Link>
    </div>
  );
}
