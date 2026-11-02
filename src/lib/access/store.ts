import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { PERMISSIONS, SUPER_ADMIN_ROLE, type Permission, sanitizePermissions } from "@/lib/auth/permissions";
import { supabaseConfigured, supabaseServiceKey, supabaseUrl } from "@/lib/env";
import { AppError } from "@/lib/errors";
import type { Session } from "@/lib/auth/session";

export type RoleRecord = { id: string; name: string; permissions: Permission[]; system: boolean };
export type UserRecord = { id: string; email: string; displayName: string; roleId: string; roleName: string; active: boolean };
export type AuditRecord = { id: string; at: string; actorEmail: string; action: string; entity: string; entityId: string | null; before: unknown; after: unknown };
export type Notice = { id: string; createdAt: string; kind: string; title: string; body: string; data: Record<string, unknown>; read: boolean };

type FileDb = { roles: RoleRecord[]; users: UserRecord[]; audit: AuditRecord[]; notices: Array<Notice & { readBy: string[] }> };

const FILE = path.join(process.cwd(), "data", "access.json");

function empty(): FileDb {
  return { roles: [systemRole()], users: [], audit: [], notices: [] };
}

function systemRole(): RoleRecord {
  return { id: "role-super-admin", name: SUPER_ADMIN_ROLE, permissions: [...PERMISSIONS], system: true };
}

function readFile(): FileDb {
  try {
    const parsed = JSON.parse(readFileSync(FILE, "utf8")) as FileDb;
    if (!parsed.roles?.some((role) => role.name === SUPER_ADMIN_ROLE)) parsed.roles = [systemRole(), ...(parsed.roles ?? [])];
    return parsed;
  } catch {
    return empty();
  }
}

function writeFile(db: FileDb) {
  mkdirSync(path.dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(db));
}

function sb(): SupabaseClient {
  return createClient(supabaseUrl(), supabaseServiceKey(), { auth: { persistSession: false, autoRefreshToken: false } });
}

function fail(error: { message?: string; code?: string } | null, action: string): never {
  const missing = error?.code === "42P01" || error?.code === "PGRST205" || /does not exist|schema cache/i.test(error?.message ?? "");
  if (missing) throw new AppError("Migrasi 0003_phase1.sql belum dijalankan di Supabase.");
  throw new AppError(error?.message || `Gagal ${action}.`);
}

export async function permissionsFor(session: Session): Promise<Permission[]> {
  const email = session.email.trim().toLowerCase();
  const bootstrap = process.env.BOOTSTRAP_SUPER_ADMIN_EMAIL?.trim().toLowerCase();
  if (bootstrap && email === bootstrap) await promote(email);
  const user = await findUser(email);
  if (user?.active) {
    const role = await findRole(user.roleId);
    return role?.permissions ?? [];
  }
  if (user && !user.active) throw new AppError("Akun dinonaktifkan.", 403);
  if (session.mode === "demo" && (await countUsers()) === 0) {
    await promote(email);
    return [...PERMISSIONS];
  }
  throw new AppError("Akun ini belum punya peran. Super Admin bisa mengundangnya, atau set BOOTSTRAP_SUPER_ADMIN_EMAIL.", 403);
}

async function promote(email: string) {
  const role = await superRole();
  if (supabaseConfigured()) {
    const client = sb();
    const { error } = await client.from("app_users").upsert({
      email,
      role_id: role.id,
      active: true,
      updated_at: new Date().toISOString(),
    }, { onConflict: "email" });
    if (error) fail(error, "mengangkat Super Admin");
    return;
  }
  const db = readFile();
  const existing = db.users.find((user) => user.email === email);
  if (existing) {
    existing.roleId = role.id;
    existing.roleName = role.name;
    existing.active = true;
  } else {
    db.users.push({ id: crypto.randomUUID(), email, displayName: "", roleId: role.id, roleName: role.name, active: true });
  }
  writeFile(db);
}

async function superRole(): Promise<RoleRecord> {
  if (!supabaseConfigured()) {
    const db = readFile();
    return db.roles.find((role) => role.name === SUPER_ADMIN_ROLE) ?? systemRole();
  }
  const client = sb();
  const found = await client.from("roles").select("*").eq("name", SUPER_ADMIN_ROLE).maybeSingle();
  if (found.error) fail(found.error, "membaca peran");
  if (found.data) {
    return { id: String(found.data.id), name: SUPER_ADMIN_ROLE, permissions: sanitizePermissions(found.data.permissions), system: true };
  }
  const inserted = await client.from("roles").insert({ name: SUPER_ADMIN_ROLE, permissions: [...PERMISSIONS], is_system: true }).select("*").single();
  if (inserted.error) fail(inserted.error, "membuat peran Super Admin");
  return { id: String(inserted.data.id), name: SUPER_ADMIN_ROLE, permissions: [...PERMISSIONS], system: true };
}

async function findUser(email: string): Promise<UserRecord | null> {
  if (!supabaseConfigured()) {
    return readFile().users.find((user) => user.email === email) ?? null;
  }
  const client = sb();
  const { data, error } = await client.from("app_users").select("id,email,display_name,role_id,active,roles(name)").eq("email", email).maybeSingle();
  if (error) fail(error, "membaca pengguna");
  if (!data) return null;
  const roles = data.roles as { name?: string } | { name?: string }[] | null;
  const roleName = Array.isArray(roles) ? roles[0]?.name ?? "" : roles?.name ?? "";
  return { id: String(data.id), email: String(data.email), displayName: String(data.display_name ?? ""), roleId: String(data.role_id), roleName, active: Boolean(data.active) };
}

async function findRole(id: string): Promise<RoleRecord | null> {
  if (!supabaseConfigured()) return readFile().roles.find((role) => role.id === id) ?? null;
  const client = sb();
  const { data, error } = await client.from("roles").select("*").eq("id", id).maybeSingle();
  if (error) fail(error, "membaca peran");
  if (!data) return null;
  return { id: String(data.id), name: String(data.name), permissions: sanitizePermissions(data.permissions), system: Boolean(data.is_system) };
}

async function countUsers(): Promise<number> {
  if (!supabaseConfigured()) return readFile().users.length;
  const client = sb();
  const { count, error } = await client.from("app_users").select("id", { count: "exact", head: true });
  if (error) fail(error, "menghitung pengguna");
  return count ?? 0;
}

export async function listRoles(): Promise<RoleRecord[]> {
  if (!supabaseConfigured()) return readFile().roles;
  const client = sb();
  const { data, error } = await client.from("roles").select("*").order("name");
  if (error) fail(error, "membaca peran");
  return (data ?? []).map((row) => ({ id: String(row.id), name: String(row.name), permissions: sanitizePermissions(row.permissions), system: Boolean(row.is_system) }));
}

export async function saveRole(input: { id?: string; name: string; permissions: string[] }) {
  const permissions = sanitizePermissions(input.permissions);
  const name = input.name.trim();
  if (!name) throw new AppError("Nama peran wajib diisi.");
  if (supabaseConfigured()) {
    const client = sb();
    if (input.id) {
      const { error } = await client.from("roles").update({ name, permissions, updated_at: new Date().toISOString() }).eq("id", input.id).eq("is_system", false);
      if (error) fail(error, "menyimpan peran");
      return;
    }
    const { error } = await client.from("roles").insert({ name, permissions, is_system: false });
    if (error) fail(error, "membuat peran");
    return;
  }
  const db = readFile();
  if (input.id) {
    const role = db.roles.find((item) => item.id === input.id);
    if (!role) throw new AppError("Peran tidak ditemukan.");
    if (role.system) throw new AppError("Peran sistem tidak diubah namanya dari sini.");
    role.name = name;
    role.permissions = permissions;
  } else {
    db.roles.push({ id: crypto.randomUUID(), name, permissions, system: false });
  }
  writeFile(db);
}

export async function listUsers(): Promise<UserRecord[]> {
  if (!supabaseConfigured()) return readFile().users;
  const client = sb();
  const { data, error } = await client.from("app_users").select("id,email,display_name,role_id,active,roles(name)").order("email");
  if (error) fail(error, "membaca pengguna");
  return (data ?? []).map((row) => {
    const roles = row.roles as { name?: string } | { name?: string }[] | null;
    const roleName = Array.isArray(roles) ? roles[0]?.name ?? "" : roles?.name ?? "";
    return { id: String(row.id), email: String(row.email), displayName: String(row.display_name ?? ""), roleId: String(row.role_id), roleName, active: Boolean(row.active) };
  });
}

export async function saveUser(input: { id?: string; email: string; displayName?: string; roleId: string; active?: boolean }) {
  const email = input.email.trim().toLowerCase();
  if (!email) throw new AppError("Email wajib diisi.");
  if (supabaseConfigured()) {
    const client = sb();
    const payload = { email, display_name: input.displayName ?? "", role_id: input.roleId, active: input.active !== false, updated_at: new Date().toISOString() };
    const { error } = input.id
      ? await client.from("app_users").update(payload).eq("id", input.id)
      : await client.from("app_users").upsert(payload, { onConflict: "email" });
    if (error) fail(error, "menyimpan pengguna");
    return;
  }
  const db = readFile();
  const role = db.roles.find((item) => item.id === input.roleId);
  if (!role) throw new AppError("Peran tidak ditemukan.");
  const existing = db.users.find((user) => user.id === input.id || user.email === email);
  if (existing) {
    existing.email = email;
    existing.displayName = input.displayName ?? existing.displayName;
    existing.roleId = role.id;
    existing.roleName = role.name;
    existing.active = input.active !== false;
  } else {
    db.users.push({ id: crypto.randomUUID(), email, displayName: input.displayName ?? "", roleId: role.id, roleName: role.name, active: input.active !== false });
  }
  writeFile(db);
}

export async function recordAudit(entry: Omit<AuditRecord, "id" | "at">) {
  const row: AuditRecord = { ...entry, id: crypto.randomUUID(), at: new Date().toISOString() };
  if (!supabaseConfigured()) {
    const db = readFile();
    db.audit.unshift(row);
    db.audit = db.audit.slice(0, 2000);
    writeFile(db);
    return;
  }
  const { error } = await sb().from("audit_log").insert({
    id: row.id, at: row.at, actor_email: row.actorEmail, action: row.action, entity: row.entity, entity_id: row.entityId, before: row.before, after: row.after,
  });
  if (error) fail(error, "mencatat audit");
}

export async function listAudit(): Promise<AuditRecord[]> {
  if (!supabaseConfigured()) return readFile().audit.slice(0, 200);
  const { data, error } = await sb().from("audit_log").select("*").order("at", { ascending: false }).limit(200);
  if (error) fail(error, "membaca audit");
  return (data ?? []).map((row) => ({
    id: String(row.id), at: String(row.at), actorEmail: String(row.actor_email), action: String(row.action), entity: String(row.entity), entityId: row.entity_id ? String(row.entity_id) : null, before: row.before, after: row.after,
  }));
}

export type OutboundChannel = { deliver(notice: { kind: string; title: string; body: string; data: Record<string, unknown> }): Promise<void> };

/** Extra channels (email, WhatsApp) can be pushed here later. In-app delivery always runs. */
export const outboundChannels: OutboundChannel[] = [];

export async function publishNotice(input: { kind: string; title: string; body: string; data?: Record<string, unknown> }) {
  const data = input.data ?? {};
  if (!supabaseConfigured()) {
    const db = readFile();
    db.notices.unshift({ id: crypto.randomUUID(), createdAt: new Date().toISOString(), kind: input.kind, title: input.title, body: input.body, data, read: false, readBy: [] });
    db.notices = db.notices.slice(0, 300);
    writeFile(db);
  } else {
    const { error } = await sb().from("notifications").insert({ kind: input.kind, title: input.title, body: input.body, data });
    if (error) fail(error, "menyimpan notifikasi");
  }
  for (const channel of outboundChannels) await channel.deliver({ kind: input.kind, title: input.title, body: input.body, data });
}

export async function listNotices(email: string): Promise<Notice[]> {
  if (!supabaseConfigured()) {
    return readFile().notices.slice(0, 50).map((notice) => ({ ...notice, read: notice.readBy.includes(email) }));
  }
  const { data, error } = await sb().from("notifications").select("*").order("created_at", { ascending: false }).limit(50);
  if (error) fail(error, "membaca notifikasi");
  return (data ?? []).map((row) => ({
    id: String(row.id),
    createdAt: String(row.created_at),
    kind: String(row.kind),
    title: String(row.title),
    body: String(row.body),
    data: (row.data && typeof row.data === "object" ? row.data : {}) as Record<string, unknown>,
    read: Array.isArray(row.read_by) && row.read_by.includes(email),
  }));
}

export async function markNoticesRead(email: string, ids: string[]) {
  if (!ids.length) return;
  if (!supabaseConfigured()) {
    const db = readFile();
    for (const notice of db.notices) if (ids.includes(notice.id) && !notice.readBy.includes(email)) notice.readBy.push(email);
    writeFile(db);
    return;
  }
  const client = sb();
  for (const id of ids) {
    const current = await client.from("notifications").select("read_by").eq("id", id).maybeSingle();
    if (current.error) fail(current.error, "membaca notifikasi");
    const readBy = Array.isArray(current.data?.read_by) ? current.data.read_by.map(String) : [];
    if (!readBy.includes(email)) readBy.push(email);
    const { error } = await client.from("notifications").update({ read_by: readBy }).eq("id", id);
    if (error) fail(error, "menandai notifikasi");
  }
}
