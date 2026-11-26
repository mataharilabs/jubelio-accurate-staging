import { NextResponse } from "next/server";
import { requireFees } from "@/lib/fees/access";
import { feeTemplate } from "@/lib/fees/template";
import { contentDisposition } from "@/lib/export/files";
import { fail } from "@/lib/http";

export async function GET() {
  try {
    await requireFees(false);
    const body = feeTemplate();
    return new NextResponse(new Uint8Array(body), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": contentDisposition("template-biaya-marketplace.xlsx"),
      },
    });
  } catch (error) {
    return fail(error);
  }
}
