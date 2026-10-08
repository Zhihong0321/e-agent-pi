import { useState, type FormEvent } from "react";
import "./users.css";

type Person = {
  id: string; member_id?: string | null; user_id?: string | null; name: string;
  email: string; department: string; username?: string | null;
  has_login?: boolean; login_active?: boolean; role?: string | null;
};
export type UserAccountPatch = {
  name: string; username: string; role: "admin" | "user"; active: boolean;
  password?: string; user_id?: string;
};
type Draft = { person: Person | null; name: string; username: string; password: string; role: "admin" | "user"; active: boolean };
const emptyDraft = (): Draft => ({ person: null, name: "", username: "", password: "", role: "user", active: true });

export function UsersPanel({ user, members, ready, onSave, onRefresh, onNotice }: {
  user: { id: string; role: string }; members: Person[]; ready: boolean;
  onSave: (patch: UserAccountPatch, personId?: string) => Promise<void>;
  onRefresh: () => Promise<void>; onNotice: (message: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const accounts = members.filter(person => person.has_login);
  const contacts = members.filter(person => !person.has_login);
  const rows = accounts.filter(person =>
    (filter === "all" || (filter === "active" ? person.login_active : !person.login_active)) &&
    `${person.name} ${person.username || ""} ${person.email} ${person.department}`.toLowerCase().includes(search.toLowerCase()));
  const edit = (person: Person) => {
    setError("");
    setDraft({ person, name: person.name, username: person.username || "", password: "", role: person.role === "admin" ? "admin" : "user", active: person.has_login ? Boolean(person.login_active) : true });
  };
  const refresh = async () => {
    setBusy(true); setError("");
    try { await onRefresh(); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not load users"); }
    finally { setBusy(false); }
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft || busy) return;
    setBusy(true); setError("");
    try {
      await onSave({ name: draft.name.trim(), username: draft.username.trim().toLowerCase(), role: draft.role, active: draft.active,
        user_id: draft.person?.user_id || undefined, ...(draft.password ? { password: draft.password } : {}) }, draft.person?.member_id || undefined);
      onNotice(draft.person?.has_login ? "User account updated" : "User account created");
      setDraft(null);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not save user"); }
    finally { setBusy(false); }
  };

  if (user.role !== "admin") return <section className="demo-panel um-restricted"><h2>Admin access required</h2><p>Sign in with an admin account to manage workspace users.</p></section>;

  return <section className="um-panel" aria-label="User management">
    <div className="um-summary">
      <div><strong>{accounts.length}</strong><span>Workspace users</span></div>
      <div><strong>{accounts.filter(person => person.login_active).length}</strong><span>Active logins</span></div>
      <div><strong>{accounts.filter(person => person.role === "admin" && person.login_active).length}</strong><span>Active admins</span></div>
    </div>
    <div className="um-layout">
      <div className="demo-panel um-directory">
        <div className="um-title"><div><h2>Workspace users</h2><p>Control login access and permissions for your team.</p></div><button className="demo-primary" disabled={!ready || busy} onClick={() => { setError(""); setDraft(emptyDraft()); }}>Add user</button></div>
        <div className="um-toolbar"><label><span className="um-sr-only">Search users</span><input type="search" placeholder="Search name, username or department" value={search} onChange={event => setSearch(event.target.value)}/></label><select aria-label="Filter login status" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All users</option><option value="active">Active</option><option value="disabled">Disabled</option></select><button className="um-secondary" disabled={busy} onClick={() => void refresh()}>Refresh</button></div>
        {error && !draft && <p className="um-error" role="alert">{error}</p>}
        {!ready ? <p className="um-empty" role="status">User records are not loaded yet. Use Refresh to load them.</p> : <div className="um-table-scroll"><table><thead><tr><th scope="col">Person</th><th scope="col">Username</th><th scope="col">Role</th><th scope="col">Login</th><th scope="col"><span className="um-sr-only">Actions</span></th></tr></thead><tbody>{rows.map(person => <tr key={person.id}><td><strong>{person.name}{person.user_id === user.id && <small className="um-you">You</small>}</strong><small>{person.email || person.department || "No contact details"}</small></td><td>{person.username}</td><td>{person.role === "admin" ? "Admin" : "User"}</td><td><span className={`um-status ${person.login_active ? "is-active" : ""}`}>{person.login_active ? "Active" : "Disabled"}</span></td><td><button className="um-secondary" disabled={busy} aria-label={`Edit ${person.name}`} onClick={() => edit(person)}>Edit</button></td></tr>)}</tbody></table>{!rows.length && <p className="um-empty">{accounts.length ? "No users match your search or filter." : "No workspace logins yet. Add a user or enable login for a company person."}</p>}</div>}
        {contacts.length > 0 && <div className="um-contacts"><h3>Company people without a login</h3><p>Enable access using an existing person’s details.</p>{contacts.map(person => <div className="um-contact" key={person.id}><div><strong>{person.name}</strong><small>{person.email || person.department || "Contact-only"}</small></div><button className="um-secondary" disabled={busy} onClick={() => edit(person)}>Enable login</button></div>)}</div>}
      </div>
      {draft ? <form className="demo-panel um-form" onSubmit={save}>
        <div className="um-title"><h2>{draft.person?.has_login ? "Edit user" : "Add user"}</h2><button type="button" className="um-secondary" disabled={busy} onClick={() => { setDraft(null); setError(""); }}>Cancel</button></div>
        <fieldset disabled={busy}>
          <label>Full name<input required maxLength={100} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })}/></label>
          <label>Username<input aria-label="Username" aria-describedby="um-username-help" required pattern="[a-zA-Z0-9][a-zA-Z0-9_.\-]{0,63}" maxLength={64} autoComplete="off" value={draft.username} onChange={event => setDraft({ ...draft, username: event.target.value })}/><small id="um-username-help">Letters, digits, dots, underscores or hyphens.</small></label>
          <label>{draft.person?.has_login ? "New password" : "Password"}<input aria-label={draft.person?.has_login ? "New password" : "Password"} aria-describedby="um-password-help" type="password" required={!draft.person?.has_login} minLength={4} maxLength={256} autoComplete="new-password" value={draft.password} onChange={event => setDraft({ ...draft, password: event.target.value })}/><small id="um-password-help">{draft.person?.has_login ? "Leave blank to keep the current password." : "At least 4 characters."}</small></label>
          <label>Role<select aria-label="Role" aria-describedby="um-role-help" value={draft.role} onChange={event => setDraft({ ...draft, role: event.target.value as Draft["role"] })}><option value="user">User</option><option value="admin">Admin</option></select><small id="um-role-help">Admins can manage user accounts and workspace access.</small></label>
          <label className="um-checkbox"><input type="checkbox" checked={draft.active} onChange={event => setDraft({ ...draft, active: event.target.checked })}/> Login enabled</label>
        </fieldset>
        <p className="um-help">Disabling access or changing a role or password signs this user out. At least one active admin must remain.</p>
        {error && <p className="um-error" role="alert">{error}</p>}
        <button className="demo-primary" disabled={busy} type="submit">{busy ? "Saving…" : draft.person?.has_login ? "Save changes" : "Create login"}</button>
      </form> : <aside className="demo-panel um-help-card"><div className="demo-panel-kicker">WORKSPACE ACCESS</div><h2>Give your team access</h2><p>Add a new user or enable a login for someone already in Company people.</p><p>Use Edit to change a role, set a new password, or disable login access.</p></aside>}
    </div>
  </section>;
}
