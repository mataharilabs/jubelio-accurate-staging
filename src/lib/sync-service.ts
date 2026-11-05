import { openDatabase, refreshTokens, saveSalesInvoice, tokenNeedsRefresh } from "@/lib/accurate/client";
import { buildInvoice, invoiceUrl } from "@/lib/accurate/invoice";
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
  const blocked = prepared.filter((item) => !item.row.selectable);
  if (blocked.length) {
    throw new AppError(`${blocked.length} pesanan belum dikonfirmasi, dianggap tidak berubah, atau tidak boleh disync (Status saja / Sama).`);
  }
  if (!salesPushEnabled()) {
    for (const item of prepared) {
      await store.logSync({ actor: by, action: "blocked", noPesanan: item.row.noPesanan, note: "ACCURATE_SALES_PUSH belum enabled" });
    }
    throw new AppError("Pengiriman penjualan ke Accurate ditahan. Set ACCURATE_SALES_PUSH=enabled hanya setelah SOP disetujui. Tidak ada data yang dikirim.");
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
  const settings = await store.getSettings();
  const databaseId = settings.accurateDatabaseId || accurateEnv().databaseId;
  if (!databaseId) throw new AppError("ID database Accurate belum diisi. Isi di Koneksi Accurate.");
  const opened = await openDatabase(tokens.accessToken, databaseId);
  const writes: SyncWrite[] = [];
  for (const item of prepared) {
    const category = item.row.category;
    const version = item.row.current;
    const intent = accurateIntent({
      status: version.status,
      everSynced: Boolean(item.state?.lastSyncedVersionId || item.state?.accurateId),
      orderDay: version.day,
      ppnReportDate: settings.ppnReportDate,
    });
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
    const action = item.state?.accurateId ? "update" : "create";
    try {
      const draft = buildInvoice(version, settings, item.state?.accurateId, invoiceUrl(opened.host));
      if (draft.blockedReason) throw new AppError(draft.blockedReason);
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
