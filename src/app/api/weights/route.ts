import { NextResponse } from "next/server";
import { readWeightWorkbook } from "@/lib/cleanup/read-xlsx";
import { getStore } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { fail, requireSession } from "@/lib/http";

export async function GET() {
  try {
    await requireSession();
    const store = await getStore();
    const [weights, reviews] = await Promise.all([store.listWeights(), store.listReviews()]);
    return NextResponse.json({ weights, reviews: reviews.filter((row) => row.kind === "bobot" && row.status === "open") });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request) {
  try {
    await requireSession();
    const store = await getStore();
    const type = request.headers.get("content-type") ?? "";
    if (type.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) throw new AppError("Pilih berkas bobot.");
      const count = await store.upsertWeights(readWeightWorkbook(Buffer.from(await file.arrayBuffer())), form.get("replace") === "1");
      return NextResponse.json({ count });
    }
    const body = (await request.json()) as { id?: string; bundleKey?: string; bobot?: number; deleteId?: string };
    if (body.deleteId) {
      await store.deleteWeight(body.deleteId);
      return NextResponse.json({ ok: true });
    }
    if (body.id) {
      const weight = await store.updateWeight(body.id, { bundleKey: body.bundleKey, bobot: body.bobot });
      return NextResponse.json(weight);
    }
    if (!body.bundleKey || body.bobot == null) throw new AppError("Kunci dan bobot wajib diisi.");
    await store.upsertWeights([{ bundleKey: body.bundleKey, bobot: Number(body.bobot) }], false);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
