"use client";

import { useEffect, useState } from "react";
import { clampPageSize, PAGE_SIZE_OPTIONS } from "@/lib/page-size";

export function usePageSize(tableKey: string, fallback = 25): [number, (next: number) => void, boolean] {
  const [size, setSize] = useState(fallback);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setSize(clampPageSize(window.localStorage.getItem(`rows:${tableKey}`), fallback));
    setHydrated(true);
  }, [tableKey, fallback]);
  function update(next: number) {
    const value = clampPageSize(next, fallback);
    setSize(value);
    window.localStorage.setItem(`rows:${tableKey}`, String(value));
  }
  return [size, update, hydrated];
}

export function useClientPage<T>(rows: T[], tableKey: string, fallback = 25) {
  const [pageSize, setStoredSize] = usePageSize(tableKey, fallback);
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / pageSize) || 1);
  const safe = Math.min(page, pages - 1);
  const shown = rows.slice(Math.max(0, safe) * pageSize, Math.max(0, safe) * pageSize + pageSize);
  return {
    page: Math.max(0, safe),
    pages,
    pageSize,
    setPage,
    setPageSize: (next: number) => {
      setStoredSize(next);
      setPage(0);
    },
    shown,
    total: rows.length,
  };
}

export function Pager({
  page,
  pageSize,
  total,
  shown,
  onPage,
  onPageSize,
}: {
  page: number;
  pageSize: number;
  total: number;
  shown: number;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / Math.max(pageSize, 1)) || 1);
  const from = shown ? page * pageSize + 1 : 0;
  const to = shown ? page * pageSize + shown : 0;
  const value = (PAGE_SIZE_OPTIONS as readonly number[]).includes(pageSize) ? pageSize : PAGE_SIZE_OPTIONS[1];
  return (
    <div className="pager">
      <span>Menampilkan {from}–{to} dari {total}</span>
      <label className="pager-size">Baris
        <select aria-label="Baris per halaman" value={value} onChange={(event) => onPageSize(clampPageSize(event.target.value, pageSize))}>
          {PAGE_SIZE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </label>
      <span>
        <button type="button" className="btn sm" disabled={page <= 0} onClick={() => onPage(page - 1)}>‹</button>
        <button type="button" className="btn sm on">{Math.min(page + 1, pages)}</button>
        <button type="button" className="btn sm" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>›</button>
      </span>
    </div>
  );
}
