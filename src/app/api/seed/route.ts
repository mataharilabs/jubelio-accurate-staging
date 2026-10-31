import { NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { fail, requireSession } from "@/lib/http";
import { seedReferenceData, seedSampleSales } from "@/lib/sample-data";

export async function POST() {
  try {
    const session = await requireSession();
    const store = await getStore();
    await seedReferenceData(store);
    await seedSampleSales(store, session.email);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
