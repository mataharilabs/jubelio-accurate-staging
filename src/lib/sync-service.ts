import { createCustomer, findCustomersByName, findSalesInvoiceByNumber, openDatabase, refreshTokens, saveSalesInvoice, tokenNeedsRefresh } from "@/lib/accurate/client";
import { buyerName, missingCustomerScopes, normalizeCustomerKey, resolveBuyerCustomer } from "@/lib/accurate/customer";
import { buildInvoice, invoiceNumberError, invoiceUrl } from "@/lib/accurate/invoice";
import { getStore } from "@/lib/db";
import type { SyncWrite } from "@/lib/db/store";
import { accurateConfigured, accurateEnv, missingAccurateEnv, salesPushEnabled } from "@/lib/env";
import { accurateIntent } from "@/lib/domain/phase3";
import { AppError } from "@/lib/errors";

export async function executeSync(nos: string[], by: string) {
  if (!nos.length) throw new AppError("Pilih pesanan yang akan disync.");
  const store = await getStore();
  const prepared = await store.prepareSync(nos);
  if (!prepared.length) throw new AppError("Pesanan yang dipilih tidak ada di antrian.");
  const settingsForIntent = await store.getSettings();
  const described = prepared.map((item) => ({
    item,
    intent: accurateIntent({
      status: item.row.current.status,
      everSynced: Boolean(item.state?.lastSyncedVersionId || item.state?.accurateId),
      orderDay: item.row.current.day,
      ppnReportDate: settingsForIntent.ppnReportDate,
      lossSibling: Boolean(item.row.current.lossSibling),
    }),
  }));
  const closed = described.filter((row) => row.intent.block);
  const silent = described.filter((row) => !row.intent.block && !row.intent.send && row.intent.label.startsWith("Tidak dikirim"));
  const actionable = described.filter((row) => !row.intent.block && !row.intent.label.startsWith("Tidak dikirim"));
  if (!actionable.length) {
    throw new AppError(closed.length && !silent.length
      ? "Cancel pada periode yang sudah tutup buku tidak diproses otomatis. Gunakan Abaikan."
      : "Pesanan ini tidak dikirim ke Accurate. Gunakan Abaikan agar keluar dari antrean.");
  }
  if (!salesPushEnabled()) {
    for (const row of actionable) {
      await store.logSync({ actor: by, action: "blocked", noPesanan: row.item.row.noPesanan, note: "ACCURATE_SALES_PUSH belum enabled" });
    }
    const held = closed.length ? ` ${closed.length} pesanan cancel yang sudah tutup buku tidak ikut dan hanya bisa diabaikan.` : "";
    throw new AppError(`Pengiriman penjualan ke Accurate ditahan. Set ACCURATE_SALES_PUSH=enabled hanya setelah SOP disetujui. Tidak ada data yang dikirim.${held}`);
  }
  const blocked = actionable.filter((row) => row.intent.send && !row.item.row.selectable);
  if (blocked.length) {
    throw new AppError(`${blocked.length} pesanan belum dikonfirmasi, dianggap tidak berubah, atau tidak boleh disync (Status saja / Sama).`);
  }
  if (!accurateConfigured() || missingAccurateEnv().length) {
    throw new AppError("Accurate belum terhubung. Isi ACCURATE_CLIENT_ID dan ACCURATE_CLIENT_SECRET, lalu hubungkan di Koneksi Accurate. Tidak ada pesanan yang dikirim.");
  }
  let tokens = await store.getTokens();
  if (!tokens?.accessToken) {
    throw new AppError("Accurate belum terhubung. Buka Koneksi Accurate dan selesaikan OAuth. Tidak ada pesanan yang dikirim.");
  }
  if (tokenNeedsRefresh(tokens)) {
    tokens = await refreshTokens(tokens);
    await store.saveTokens(tokens);
  }
  const settings = settingsForIntent;
  const databaseId = settings.accurateDatabaseId || accurateEnv().databaseId;
  if (!databaseId) throw new AppError("ID database Accurate belum diisi. Isi di Koneksi Accurate.");
  const opened = await openDatabase(tokens.accessToken, databaseId);
  const writes: SyncWrite[] = [];
  for (const row of actionable) {
    const item = row.item;
    const intent = row.intent;
    const category = item.row.category;
    const version = item.row.current;
    if (category === "Batal" || category === "Returned" || !intent.send) {
      const error = `${intent.label}. Cancel dan retur belum dikirim ke Accurate (stub).`;
      await store.logSync({ actor: by, action: "blocked", noPesanan: version.noPesanan, note: error });
      writes.push({
        noPesanan: version.noPesanan,
        versionId: version.id,
        category,
        action: category === "Batal" ? "delete" : "update",
        status: "gagal",
        accurateId: item.state?.accurateId ?? null,
        accurateNumber: item.state?.accurateNumber ?? null,
        error,
      });
      continue;
    }
    let action: "create" | "update" = item.state?.accurateId ? "update" : "create";
    try {
      const numberProblem = invoiceNumberError(version.noPesanan);
      if (numberProblem) throw new AppError(numberProblem);
      const name = buyerName(version.customerName);
      const cached = name ? await store.findAccurateCustomer(normalizeCustomerKey(name)) : null;
      if (name && !cached) {
        const missing = missingCustomerScopes(tokens.scope);
        if (missing.length) {
          throw new AppError(`Token Accurate belum mencakup ${missing.join(" ")}. Buka Koneksi Accurate dan klik Hubungkan Accurate lagi.`);
        }
      }
      const resolved = await resolveBuyerCustomer({
        buyerName: name,
        defaultCustomerNo: settings.defaultCustomerNo,
        defaultCustomerName: settings.defaultCustomerName,
        cached,
        lookup: (buyer) => findCustomersByName(tokens.accessToken, opened.host, opened.session, buyer),
        create: (buyer) => createCustomer(tokens.accessToken, opened.host, opened.session, buyer),
      });
      if (resolved.cache) {
        await store.saveAccurateCustomer({ ...resolved.cache, createdAt: new Date().toISOString() });
      }
      if (resolved.log) {
        await store.logSync({ actor: by, action: "sync", noPesanan: version.noPesanan, note: resolved.log });
      }
      let accurateId = item.state?.accurateId ?? null;
      let reusedNumber: string | null = null;
      if (!accurateId) {
        const existing = await findSalesInvoiceByNumber(tokens.accessToken, opened.host, opened.session, version.noPesanan);
        if (existing) {
          accurateId = existing.id;
          reusedNumber = existing.number;
          action = "update";
        }
      }
      const draft = buildInvoice(version, settings, accurateId, invoiceUrl(opened.host), {
        customerNo: resolved.customerNo,
        customerName: resolved.customerName,
      });
      if (draft.blockedReason) throw new AppError(draft.blockedReason);
      if (reusedNumber && accurateId) {
        await store.logSync({
          actor: by,
          action: "sync",
          noPesanan: version.noPesanan,
          note: `Faktur Accurate nomor ${reusedNumber} sudah ada (id ${accurateId}). Dipakai untuk update, bukan membuat duplikat.`,
        });
      }
      const saved = await saveSalesInvoice(tokens.accessToken, opened.host, opened.session, draft);
      writes.push({
        noPesanan: version.noPesanan,
        versionId: version.id,
        category,
        action,
        status: "berhasil",
        accurateId: saved.accurateId ?? item.state?.accurateId ?? null,
        accurateNumber: saved.accurateNumber,
        error: null,
      });
    } catch (error) {
      writes.push({
        noPesanan: version.noPesanan,
        versionId: version.id,
        category,
        action,
        status: "gagal",
        accurateId: item.state?.accurateId ?? null,
        accurateNumber: item.state?.accurateNumber ?? null,
        error: error instanceof Error ? error.message : "Gagal sync.",
      });
    }
  }
  const batch = await store.recordSync(by, writes, writes.some((item) => item.status === "gagal") ? "Sebagian gagal" : "Selesai");
  return { batch, items: writes };
}
