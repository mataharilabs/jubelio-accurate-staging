import { NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { importSalesBuffer } from "@/lib/sample-data";
import { fail, readUpload, requireSession } from "@/lib/http";

export async function POST(request: Request) {
  try {
    const session = await requireSession();
    const file = await readUpload(request);
    const batch = await importSalesBuffer(await getStore(), file.buffer, file.name, session.email);
    return NextResponse.json(batch);
  } catch (error) {
    return fail(error);
  }
}
