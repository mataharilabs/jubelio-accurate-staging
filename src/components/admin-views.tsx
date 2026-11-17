"use client";

import { useEffect, useState } from "react";
import { ActionButton, reported, reportedOk, TableShell } from "@/components/ui/feedback";
import { Pager, useClientPage } from "@/components/ui/pager";
import { api } from "@/lib/api-client";
import { PERMISSIONS } from "@/lib/auth/permissions";

type Role = { id: string; name: string; permissions: string[]; system: boolean };
type User = { id: string; email: string; displayName: string; roleId: string; active: boolean };
type Audit = { id: string; at: string; actorEmail: string; action: string; entity: string; entityId: string | null };

export function UsersView() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [email, setEmail] = useState("");
  const [roleId, setRoleId] = useState("");
  const [roleName, setRoleName] = useState("");
  const [perms, setPerms] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    api<{ users: User[]; roles: Role[] }>("/api/users").then((result) => {
      setUsers(result.users);
      setRoles(result.roles);
      if (!roleId && result.roles[0]) setRoleId(result.roles[0].id);
    }).catch((err: Error) => setError(reported(err, "Gagal memuat pengguna."))).finally(() => setLoading(false));
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const userPage = useClientPage(users, "users", 25);

  return (
    <div className="grid g2">
      {error ? <div className="warnbox">{error}</div> : null}
      <div className="card">
        <h3>Pengguna</h3>
        <p className="small mut">Satu peran per pengguna. Tidak membuat akun login dan tidak mengirim undangan. Isi email yang sudah bisa masuk.</p>
        <div className="filters">
          <input placeholder="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          <select value={roleId} onChange={(event) => setRoleId(event.target.value)}>{roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select>
          <ActionButton className="btn pri" onClick={() => api("/api/users", { method: "POST", body: JSON.stringify({ email, roleId, active: true }) }).then(() => { setEmail(""); reportedOk("Pengguna disimpan."); load(); }).catch((err: Error) => setError(reported(err, "Gagal menyimpan pengguna.")))}>Simpan</ActionButton>
        </div>
        <TableShell loading={loading}>
        <table className="cards mt"><thead><tr><th>Nama</th><th>Email</th><th>Peran</th><th>Status</th><th></th></tr></thead><tbody>
          {userPage.shown.map((user) => (
            <tr key={user.id}>
              <td data-label="Nama">{user.displayName || "—"}</td>
              <td data-label="Email">{user.email}</td>
              <td data-label="Peran"><span className="pill p-pur">{roles.find((role) => role.id === user.roleId)?.name}</span></td>
              <td data-label="Status">{user.active ? <span className="pill p-ok">Aktif</span> : <span className="pill p-gray">Nonaktif</span>}</td>
              <td><ActionButton className="btn sm" onClick={() => api("/api/users", { method: "POST", body: JSON.stringify({ id: user.id, email: user.email, roleId: user.roleId, active: !user.active }) }).then(() => { reportedOk(user.active ? "Pengguna dinonaktifkan." : "Pengguna diaktifkan."); load(); }).catch((err: Error) => setError(reported(err, "Gagal mengubah pengguna.")))}>{user.active ? "Nonaktifkan" : "Aktifkan"}</ActionButton></td>
            </tr>
          ))}
        </tbody></table>
        <Pager page={userPage.page} pageSize={userPage.pageSize} total={userPage.total} shown={userPage.shown.length} onPage={userPage.setPage} onPageSize={userPage.setPageSize} />
        </TableShell>
        <p className="small mut mt">Tidak membuat akun login dan tidak mengirim undangan. Email harus sudah bisa masuk.</p>
      </div>
      <div className="card">
        <h3>Peran</h3>
        <input placeholder="Nama peran" value={roleName} onChange={(event) => setRoleName(event.target.value)} />
        <div className="mt" style={{ display: "grid", gap: 4 }}>
          {PERMISSIONS.map((permission) => (
            <label key={permission} className="small"><input type="checkbox" checked={perms.includes(permission)} onChange={() => setPerms((current) => current.includes(permission) ? current.filter((item) => item !== permission) : [...current, permission])} /> {permission}</label>
          ))}
        </div>
        <ActionButton className="btn mt" onClick={() => api("/api/users", { method: "PUT", body: JSON.stringify({ name: roleName, permissions: perms }) }).then(() => { setRoleName(""); setPerms([]); reportedOk("Peran ditambahkan."); load(); }).catch((err: Error) => setError(reported(err, "Gagal menambah peran.")))}>Tambah peran</ActionButton>
      </div>
      <div className="card" style={{ gridColumn: "1 / -1" }}>
        <h3>Hak akses per peran</h3>
        <div className="tscroll"><table className="small"><thead><tr><th>Akses</th>{roles.map((role) => <th key={role.id} className="c">{role.name}</th>)}</tr></thead><tbody>
          {PERMISSIONS.map((permission) => <tr key={permission}><td>{permission}</td>{roles.map((role) => <td key={role.id} className="c">{role.permissions.includes(permission) ? <span className="up">✓</span> : <span className="mut">—</span>}</td>)}</tr>)}
        </tbody></table></div>
      </div>
    </div>
  );
}

export function AuditView() {
  const [entries, setEntries] = useState<Audit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    api<{ entries: Audit[] }>("/api/audit").then((result) => setEntries(result.entries)).catch((err: Error) => setError(reported(err, "Gagal memuat jejak audit."))).finally(() => setLoading(false));
  }, []);
  const page = useClientPage(entries, "audit", 25);
  return (
    <div className="card">
      <h3>Jejak audit</h3>
      {error ? <div className="warnbox">{error}</div> : null}
      <TableShell loading={loading} className="tbl"><table className="cards"><thead><tr><th>Waktu</th><th>Siapa</th><th>Aksi</th><th>Objek</th></tr></thead><tbody>
        {page.shown.map((entry) => <tr key={entry.id}><td data-label="Waktu">{entry.at.slice(0, 19).replace("T", " ")}</td><td data-label="Siapa">{entry.actorEmail}</td><td data-label="Aksi">{entry.action}</td><td data-label="Objek">{entry.entity} {entry.entityId ?? ""}</td></tr>)}
      </tbody></table>
      <Pager page={page.page} pageSize={page.pageSize} total={page.total} shown={page.shown.length} onPage={page.setPage} onPageSize={page.setPageSize} />
      </TableShell>
    </div>
  );
}
