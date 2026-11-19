import { NextResponse } from "next/server";
import { contentDisposition } from "@/lib/export/files";
import { fail } from "@/lib/http";
import { requireMarketing } from "@/lib/marketing/access";
import { templateWorkbook } from "@/lib/marketing/template";

export async function GET() {
  try {
    await requireMarketing(false);
    const buffer = templateWorkbook();
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": contentDisposition("template-marketing-spending.xlsx"),
      },
    });
  } catch (error) {
    return fail(error);
  }
}
