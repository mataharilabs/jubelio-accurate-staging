import { deleteSalesInvoice, openDatabase, refreshTokens, saveSalesInvoice, tokenNeedsRefresh } from "@/lib/accurate/client";
import { buildDeleteInvoice, buildInvoice, invoiceUrl } from "@/lib/accurate/invoice";
import { getStore } from "@/lib/db";
import type { SyncWrite } from "@/lib/db/store";
import { accurateConfigured, accurateEnv, missingAccurateEnv } from "@/lib/env";
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
    const action = category === "Batal" ? "delete" : item.state?.accurateId ? "update" : "create";
    try {
      if (action === "delete") {
        const accurateId = item.state?.accurateId;
        if (!accurateId) throw new AppError("Tidak ada id faktur Accurate untuk dihapus. SOP penghapusan juga belum final.");
        buildDeleteInvoice(version.noPesanan, accurateId);
        await deleteSalesInvoice(tokens.accessToken, opened.host, opened.session, accurateId);
        writes.push({
          noPesanan: version.noPesanan,
          versionId: version.id,
          category,
          action,
          status: "berhasil",
          accurateId: null,
          accurateNumber: null,
          error: null,
        });
        continue;
      }
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
