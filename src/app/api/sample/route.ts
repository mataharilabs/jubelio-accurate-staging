import { NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { loadSampleData } from "@/lib/sample-data";
import { fail, requireSession } from "@/lib/http";

export async function POST() {
  try {
    const session = await requireSession();
    const batch = await loadSampleData(await getStore(), session.email);
    return NextResponse.json(batch);
  } catch (error) {
    return fail(error);
  }
}
