"use client";

import { useEffect, useState } from "react";
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

  function load() {
    api<{ users: User[]; roles: Role[] }>("/api/users").then((result) => {
      setUsers(result.users);
      setRoles(result.roles);
      if (!roleId && result.roles[0]) setRoleId(result.roles[0].id);
    }).catch((err: Error) => setError(err.message));
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="grid g2">
      {error ? <div className="warnbox">{error}</div> : null}
      <div className="card">
        <h3>Pengguna</h3>
        <p className="small mut">Satu peran per pengguna. Tidak membuat akun login dan tidak mengirim undangan. Isi email yang sudah bisa masuk.</p>
        <div className="filters">
          <input placeholder="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          <select value={roleId} onChange={(event) => setRoleId(event.target.value)}>{roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select>
          <button className="btn pri" onClick={() => api("/api/users", { method: "POST", body: JSON.stringify({ email, roleId, active: true }) }).then(() => { setEmail(""); load(); })}>Simpan</button>
        </div>
        <table className="cards mt"><thead><tr><th>Email</th><th>Peran</th><th></th></tr></thead><tbody>
          {users.map((user) => (
            <tr key={user.id}>
              <td data-label="Email">{user.email}{user.active ? "" : " (nonaktif)"}</td>
              <td data-label="Peran">{roles.find((role) => role.id === user.roleId)?.name}</td>
              <td><button className="btn sm" onClick={() => api("/api/users", { method: "POST", body: JSON.stringify({ id: user.id, email: user.email, roleId: user.roleId, active: !user.active }) }).then(load)}>{user.active ? "Nonaktifkan" : "Aktifkan"}</button></td>
            </tr>
          ))}
        </tbody></table>
      </div>
      <div className="card">
        <h3>Peran</h3>
        <input placeholder="Nama peran" value={roleName} onChange={(event) => setRoleName(event.target.value)} />
        <div className="mt" style={{ display: "grid", gap: 4 }}>
          {PERMISSIONS.map((permission) => (
            <label key={permission} className="small"><input type="checkbox" checked={perms.includes(permission)} onChange={() => setPerms((current) => current.includes(permission) ? current.filter((item) => item !== permission) : [...current, permission])} /> {permission}</label>
          ))}
        </div>
        <button className="btn mt" onClick={() => api("/api/users", { method: "PUT", body: JSON.stringify({ name: roleName, permissions: perms }) }).then(() => { setRoleName(""); setPerms([]); load(); })}>Tambah peran</button>
      </div>
    </div>
  );
}

export function AuditView() {
  const [entries, setEntries] = useState<Audit[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ entries: Audit[] }>("/api/audit").then((result) => setEntries(result.entries)).catch((err: Error) => setError(err.message));
  }, []);
  return (
    <div className="card">
      <h3>Jejak audit</h3>
      {error ? <div className="warnbox">{error}</div> : null}
      <div className="tbl"><table className="cards"><thead><tr><th>Waktu</th><th>Siapa</th><th>Aksi</th><th>Objek</th></tr></thead><tbody>
        {entries.map((entry) => <tr key={entry.id}><td data-label="Waktu">{entry.at.slice(0, 19).replace("T", " ")}</td><td data-label="Siapa">{entry.actorEmail}</td><td data-label="Aksi">{entry.action}</td><td data-label="Objek">{entry.entity} {entry.entityId ?? ""}</td></tr>)}
      </tbody></table></div>
    </div>
  );
}
