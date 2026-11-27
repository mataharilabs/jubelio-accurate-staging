import { listUsers, permissionsFor } from "@/lib/access/store";
import { ADMIN_ROLE, hasPermission, SUPER_ADMIN_ROLE } from "@/lib/auth/permissions";
import type { Session } from "@/lib/auth/session";
import { AppError } from "@/lib/errors";
import { requireMaster, requireSession } from "@/lib/http";
import { actorLabel } from "@/lib/marketing/access";

export { actorLabel };

export async function requireFees(write: boolean): Promise<Session> {
  if (write) return requireMaster("fees.manage");
  const session = await requireSession();
  const granted = await permissionsFor(session);
  if (hasPermission(granted, "fees.view") || hasPermission(granted, "orders.view") || hasPermission(granted, "dashboard.view")) return session;
  const users = await listUsers().catch(() => []);
  const role = users.find((item) => item.email.toLowerCase() === session.email.toLowerCase())?.roleName ?? "";
  if (role === SUPER_ADMIN_ROLE || role === ADMIN_ROLE) return session;
  throw new AppError("Tidak punya izin untuk melihat pembayaran.", 403);
}
