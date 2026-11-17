"use client";

import { useEffect, useState } from "react";
import { subscribeInflight } from "@/lib/api-client";

type ToastItem = { id: number; kind: "ok" | "bad"; text: string };

let emitToast: ((item: ToastItem) => void) | null = null;
let toastSeq = 1;

export function toastOk(text: string) {
  emitToast?.({ id: toastSeq++, kind: "ok", text });
}

export function toastBad(text: string) {
  emitToast?.({ id: toastSeq++, kind: "bad", text });
}

export function reported(error: unknown, fallback = "Gagal."): string {
  const text = error instanceof Error ? error.message : fallback;
  toastBad(text);
  return text;
}

export function reportedOk(text: string): string {
  toastOk(text);
  return text;
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

export function TopProgress() {
  const [count, setCount] = useState(0);
  useEffect(() => subscribeInflight(setCount), []);
  if (!count) return null;
  return <div className="top-progress" role="progressbar" aria-label="Memuat" />;
}

export function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    emitToast = (item) => {
      setItems((current) => [...current, item].slice(-4));
      window.setTimeout(() => {
        setItems((current) => current.filter((row) => row.id !== item.id));
      }, 4200);
    };
    return () => {
      emitToast = null;
    };
  }, []);
  if (!items.length) return null;
  return (
    <div className="toast-stack">
      {items.map((item) => (
        <div key={item.id} className={`toast ${item.kind}`} role="status">{item.text}</div>
      ))}
    </div>
  );
}

export function AppChrome() {
  return (
    <>
      <TopProgress />
      <ToastHost />
    </>
  );
}

export function TableShell({ loading, children, className = "tablecard" }: { loading?: boolean; children: React.ReactNode; className?: string }) {
  return (
    <div className={className} style={{ position: "relative" }}>
      {loading ? <div className="table-loading" role="status"><Spinner /> Memuat…</div> : null}
      {children}
    </div>
  );
}

export function ActionButton({
  className = "btn",
  children,
  disabled,
  onClick,
  type = "button",
  title,
}: {
  className?: string;
  children: React.ReactNode;
  disabled?: boolean;
  onClick?: () => void | Promise<unknown>;
  type?: "button" | "submit";
  title?: string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type={type}
      className={className}
      title={title}
      disabled={disabled || busy}
      onClick={() => {
        if (busy || disabled) return;
        let result: void | Promise<unknown>;
        try {
          result = onClick?.();
        } catch (error) {
          toastBad(error instanceof Error ? error.message : "Gagal.");
          return;
        }
        if (result && typeof (result as Promise<unknown>).then === "function") {
          setBusy(true);
          Promise.resolve(result).finally(() => setBusy(false));
        }
      }}
    >
      {busy ? <Spinner /> : null}
      {children}
    </button>
  );
}
