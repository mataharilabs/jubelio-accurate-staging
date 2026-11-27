import { NextResponse } from "next/server";
import { requireFees } from "@/lib/fees/access";
import { feeReport, type FeeReportKind } from "@/lib/fees/service";
import { fail } from "@/lib/http";
import { clampPageSize } from "@/lib/page-size";

function kindOf(value: string | null): FeeReportKind {
  if (value === "affiliate" || value === "sku" || value === "group") return value;
  return "group";
}

export async function GET(request: Request) {
  try {
    await requireFees(false);
    const url = new URL(request.url);
    const page = Number(url.searchParams.get("page") ?? "0");
    const result = await feeReport({
      kind: kindOf(url.searchParams.get("kind")),
      from: url.searchParams.get("from") || null,
      to: url.searchParams.get("to") || null,
      channels: (url.searchParams.get("channels") ?? "").split(",").map((item) => item.trim()).filter(Boolean),
      stores: (url.searchParams.get("stores") ?? "").split(",").map((item) => item.trim()).filter(Boolean),
      page: Number.isFinite(page) ? page : 0,
      pageSize: clampPageSize(url.searchParams.get("limit") ?? url.searchParams.get("pageSize"), 25),
    });
    return NextResponse.json(result);
  } catch (error) {
    return fail(error);
  }
}
