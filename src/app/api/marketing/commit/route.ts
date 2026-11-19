import { NextResponse } from "next/server";
import { fail } from "@/lib/http";
import { actorLabel, auditQuiet, requireMarketing } from "@/lib/marketing/access";
import { marketingStoreChoices } from "@/lib/marketing/catalog";
import { ConflictError, commitUpload } from "@/lib/marketing/service";
import { readMarketingFile } from "@/lib/marketing/upload";

export async function POST(request: Request) {
  try {
    const session = await requireMarketing(true);
    const upload = await readMarketingFile(request);
    if (!upload.platform) return NextResponse.json({ error: "Pilih platform iklan." }, { status: 400 });
    const result = await commitUpload({ ...upload, stores: await marketingStoreChoices(), actor: await actorLabel(session) });
    await auditQuiet({
      actorEmail: session.email,
      action: upload.overwrite ? "marketing.overwrite" : "marketing.create",
      entity: "marketing_spend",
      entityId: null,
      before: null,
      after: { filename: upload.filename, platform: upload.platform, store: upload.storeName, ...result },
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof ConflictError) return NextResponse.json({ error: error.message, duplicates: error.duplicates }, { status: 409 });
    return fail(error);
  }
}
