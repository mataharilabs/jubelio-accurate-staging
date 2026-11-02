import { NextResponse } from "next/server";
import { listNotices, markNoticesRead } from "@/lib/access/store";
import { fail, requireSession } from "@/lib/http";

export async function GET() {
  try {
    const session = await requireSession();
    const notices = await listNotices(session.email.toLowerCase());
    return NextResponse.json({ notices, unread: notices.filter((notice) => !notice.read).length });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireSession();
    const body = (await request.json()) as { ids?: string[] };
    await markNoticesRead(session.email.toLowerCase(), body.ids ?? []);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
