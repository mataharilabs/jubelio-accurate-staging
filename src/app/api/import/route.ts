import { NextResponse } from "next/server";
import { rapikan } from "@/lib/cleanup/rapikan";
import { readCleanWorkbook, readSalesWorkbook } from "@/lib/cleanup/read-xlsx";
import { getStore } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { fail, requireSession } from "@/lib/http";
import { rapikanMaps } from "@/lib/sample-data";

export async function POST(request: Request) {
  try {
    const session = await requireSession();
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new AppError("Pilih berkas .xlsx.");
    const mode = String(form.get("mode") ?? "raw");
    const from = String(form.get("from") ?? "") || null;
    const to = String(form.get("to") ?? "") || null;
    const buffer = Buffer.from(await file.arrayBuffer());
    const store = await getStore();
    if (mode === "clean") {
      const result = await store.importCleanLines(readCleanWorkbook(buffer), file.name, "clean", session.email);
      return NextResponse.json(result);
    }
    const cleaned = rapikan(readSalesWorkbook(buffer), await rapikanMaps(store), { from, to });
    const result = await store.importRawLines(cleaned.lines, cleaned.droppedCancels, file.name, session.email, { from, to });
    return NextResponse.json({ ...result, missingKeys: cleaned.missingKeys, unmappedChannels: cleaned.unmappedChannels });
  } catch (error) {
    return fail(error);
  }
}
