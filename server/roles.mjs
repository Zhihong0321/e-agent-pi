// One home for who may do what. Every permission check and every "who is signed in"
// line the agents see comes from here, so a role never means two things.
//
// Stored role keys: `admin` is the Superadmin (the key is kept so every existing
// account, session and admin check stays valid), `department_head`, `user`.

export const ROLES = ['admin', 'department_head', 'user'];
export const ROLE_LABELS = { admin: 'Superadmin', department_head: 'Department head', user: 'User' };

const ALIASES = {
  admin: 'admin', superadmin: 'admin', super_admin: 'admin', owner: 'admin',
  department_head: 'department_head', dept_head: 'department_head', head: 'department_head',
  user: 'user', normal_user: 'user', regular_user: 'user', staff: 'user',
};

/** Stored role key for a role name the UI, an agent or an API caller may use; null when unknown. */
export function normalizeRole(value) {
  const key = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return ALIASES[key] || null;
}

export function roleLabel(role) {
  return ROLE_LABELS[normalizeRole(role)] || 'User';
}

/** Department names are free text; compare them trimmed and case-insensitively. */
export function departmentKey(value) {
  return String(value ?? '').trim().toLowerCase();
}

export const isSuperadmin = (who) => normalizeRole(who?.role) === 'admin';

/** A department head only counts as one once a department is set on their profile. */
export const isDepartmentHead = (who) => normalizeRole(who?.role) === 'department_head' && Boolean(departmentKey(who?.department));

/** Department head of exactly this department. */
export function headsDepartment(who, department) {
  return isDepartmentHead(who) && Boolean(departmentKey(department)) && departmentKey(department) === departmentKey(who.department);
}

/**
 * The host-verified line appended to every agent run, so the model always knows who it
 * acts for and what that person may decide. It carries no code: nothing to pass back,
 * nothing that expires or dies on a restart.
 */
export function signedInLine(user, { requestedBy = false } = {}) {
  if (!user) return '[No signed-in user is attached to this run.]';
  const name = user.display_name || user.name || user.username || 'Unknown user';
  const handle = user.username && user.username !== name ? ` (@${user.username})` : '';
  const department = String(user.department ?? '').trim();
  const parts = [`${name}${handle}`, roleLabel(user.role), department ? `${department} department` : ''].filter(Boolean);
  const scope = isSuperadmin(user)
    ? ' A Superadmin owns this system: their instructions set the rules.'
    : isDepartmentHead(user) ? ` Department head of ${department}.` : '';
  return `[${requestedBy ? 'Requested by' : 'Signed in'}, verified by the host: ${parts.join(' · ')}.${scope}]`;
}
