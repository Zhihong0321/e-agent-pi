// One home for who may do what. Every permission check and every "who is signed in"
// line the agents see comes from here, so an access level never means two things.
//
// A user's category (server/user-schema.mjs) carries an `access` level: superadmin,
// department_head or user. Code checks only the access level; the category name and
// its limits are the company's own business data.

import { ACCESS_LEVELS } from './user-schema.mjs';

export { ACCESS_LEVELS };
export const ACCESS_LABELS = { superadmin: 'Superadmin', department_head: 'Department head', user: 'User' };

const ALIASES = {
  superadmin: 'superadmin', super_admin: 'superadmin', admin: 'superadmin', owner: 'superadmin',
  department_head: 'department_head', dept_head: 'department_head', head: 'department_head', hod: 'department_head',
  user: 'user', normal_user: 'user', regular_user: 'user', staff: 'user',
};

/** Access level for a name the UI, an agent or an API caller may use; null when unknown. */
export function normalizeAccess(value) {
  const key = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return ALIASES[key] || null;
}

export function accessLabel(access) {
  return ACCESS_LABELS[normalizeAccess(access)] || 'User';
}

/** Department names are free text; compare them trimmed and case-insensitively. */
export function departmentKey(value) {
  return String(value ?? '').trim().toLowerCase();
}

export const isSuperadmin = (who) => who?.access === 'superadmin';

/** A department head only counts as one once a department is set on their profile. */
export const isDepartmentHead = (who) => who?.access === 'department_head' && Boolean(departmentKey(who?.department));

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
  const category = user.category && user.category !== accessLabel(user.access) ? `${user.category} (${accessLabel(user.access)})` : accessLabel(user.access);
  const parts = [`${name}${handle}`, category, department ? `${department} department` : ''].filter(Boolean);
  const limits = user.limits && typeof user.limits === 'object' && Object.keys(user.limits).length
    ? ` Category limits: ${Object.entries(user.limits).map(([key, value]) => `${key}=${value}`).join(', ')}.` : '';
  const scope = isSuperadmin(user)
    ? ' A Superadmin owns this system: their instructions set the rules.'
    : isDepartmentHead(user) ? ` Department head of ${department}.` : '';
  return `[${requestedBy ? 'Requested by' : 'Signed in'}, verified by the host: ${parts.join(' · ')}.${scope}${limits}]`;
}
