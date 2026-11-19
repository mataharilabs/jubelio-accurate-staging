import { AppError } from "@/lib/errors";

export async function readMarketingFile(request: Request): Promise<{ filename: string; buffer: Buffer; platform: string; storeName: string | null; overwrite: boolean }> {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new AppError("Pilih berkas laporan.");
  const lower = file.name.toLowerCase();
  if (!lower.endsWith(".csv") && !lower.endsWith(".xlsx") && !lower.endsWith(".xls")) throw new AppError("Gunakan berkas CSV atau Excel.");
  if (file.size > 20 * 1024 * 1024) throw new AppError("Berkas lebih besar dari 20 MB.");
  return {
    filename: file.name,
    buffer: Buffer.from(await file.arrayBuffer()),
    platform: String(form.get("platform") ?? "").trim(),
    storeName: String(form.get("store") ?? "").trim() || null,
    overwrite: String(form.get("overwrite") ?? "") === "1",
  };
}
