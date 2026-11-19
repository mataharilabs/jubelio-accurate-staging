import { listUsers, permissionsFor, recordAudit, type AuditRecord } from "@/lib/access/store";
import { ADMIN_ROLE, hasPermission, SUPER_ADMIN_ROLE } from "@/lib/auth/permissions";
import type { Session } from "@/lib/auth/session";
import { AppError } from "@/lib/errors";
import { requireMaster, requireSession } from "@/lib/http";

/** App audit log is secondary. A failure here must not look like the spend write failed. */
export async function auditQuiet(entry: Omit<AuditRecord, "id" | "at">): Promise<void> {
  try {
    await recordAudit(entry);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Jejak audit tidak tercatat.");
  }
}

export async function actorLabel(session: Session): Promise<string> {
  const users = await listUsers().catch(() => []);
  const user = users.find((item) => item.email.toLowerCase() === session.email.toLowerCase());
  return user?.displayName?.trim() || session.email;
}

export async function requireMarketing(write: boolean): Promise<Session> {
  if (write) return requireMaster("marketing.manage");
  const session = await requireSession();
  const granted = await permissionsFor(session);
  if (hasPermission(granted, "marketing.view") || hasPermission(granted, "dashboard.view")) return session;
  const users = await listUsers().catch(() => []);
  const role = users.find((item) => item.email.toLowerCase() === session.email.toLowerCase())?.roleName ?? "";
  if (role === SUPER_ADMIN_ROLE || role === ADMIN_ROLE) return session;
  throw new AppError("Tidak punya izin untuk tindakan ini.", 403);
}
