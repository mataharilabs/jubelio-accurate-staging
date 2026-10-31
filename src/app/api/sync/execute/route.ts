import { NextResponse } from "next/server";
import { fail, requireSession } from "@/lib/http";
import { executeSync } from "@/lib/sync-service";

export async function POST(request: Request) {
  try {
    const session = await requireSession();
    const body = (await request.json()) as { nos?: string[] };
    const result = await executeSync(body.nos ?? [], session.email);
    return NextResponse.json(result);
  } catch (error) {
    return fail(error);
  }
}
