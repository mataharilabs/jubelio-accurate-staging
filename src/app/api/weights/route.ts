import { NextResponse } from "next/server";
import { readWeightWorkbook } from "@/lib/cleanup/read-xlsx";
import { getStore } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { fail, requireSession } from "@/lib/http";

export async function GET() {
  try {
    await requireSession();
    const weights = await (await getStore()).listWeights();
    return NextResponse.json(weights);
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request) {
  try {
    await requireSession();
    const store = await getStore();
    const type = request.headers.get("content-type") || "";
    if (type.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) throw new AppError("Pilih berkas .xlsx.");
      if (!file.name.toLowerCase().endsWith(".xlsx")) throw new AppError("Hanya berkas .xlsx yang didukung.");
      const rows = readWeightWorkbook(Buffer.from(await file.arrayBuffer()));
      const count = await store.upsertWeights(rows, form.get("replace") === "1");
      return NextResponse.json({ count });
    }
    const body = (await request.json()) as { bundleKey?: string; bobot?: number };
    if (!body.bundleKey?.trim()) throw new AppError("Isi kunci bundle.");
    if (body.bobot == null || !Number.isFinite(Number(body.bobot))) throw new AppError("Isi bobot.");
    const count = await store.upsertWeights([{ bundleKey: body.bundleKey, bobot: Number(body.bobot) }], false);
    return NextResponse.json({ count });
  } catch (error) {
    return fail(error);
  }
}
