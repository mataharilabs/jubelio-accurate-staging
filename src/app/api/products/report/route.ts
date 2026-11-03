import { NextResponse } from "next/server";
import { fail, requirePermission } from "@/lib/http";
import { productReport } from "@/lib/products/service";

export async function POST(request: Request) {
  try {
    await requirePermission("products.view");
    const body = await request.json() as Record<string, unknown>;
    return NextResponse.json(await productReport(body));
  } catch (error) {
    return fail(error);
  }
}
