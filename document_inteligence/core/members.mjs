import { DiError, setClause } from './common.mjs';

const FIELDS = ['name', 'position', 'department', 'email', 'phone', 'location', 'notes'];

export async function listCompanyMembers(tx) {
  const rows = (await tx.query(
    `SELECT id, name, position, department, email, phone, location, notes, user_id, created_at, updated_at
       FROM di.company_member
      WHERE tenant_id=di.current_tenant() AND deleted_at IS NULL
      ORDER BY department NULLS LAST, name LIMIT 201`,
  )).rows;
  return { members: rows.slice(0, 200), has_more: rows.length > 200 };
}

export async function saveCompanyMember(tx, { id, ...input } = {}) {
  const patch = {};
  for (const key of FIELDS) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'string') throw new DiError(`${key} must be text`);
    const value = input[key].trim();
    if (value.length > (key === 'notes' ? 2000 : 300)) throw new DiError(`${key} is too long`);
    patch[key] = value || null;
  }
  if (patch.email) {
    patch.email = patch.email.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patch.email)) throw new DiError('Invalid member email');
  }
  if (!Object.keys(patch).length) throw new DiError('Give at least one member field');

  let existing = null;
  if (id) {
    existing = (await tx.query(
      'SELECT * FROM di.company_member WHERE id=$1 AND tenant_id=di.current_tenant() AND deleted_at IS NULL FOR UPDATE', [id],
    )).rows[0];
    if (!existing) throw new DiError('Company member not found');
  }
  const name = patch.name === undefined ? existing?.name : patch.name;
  if (!name) throw new DiError('A company member needs a name');
  const email = patch.email === undefined ? existing?.email : patch.email;
  const phone = patch.phone === undefined ? existing?.phone : patch.phone;
  const matches = (await tx.query(
    `SELECT id, name FROM di.company_member
      WHERE tenant_id=di.current_tenant() AND deleted_at IS NULL
        AND (($1::text IS NOT NULL AND lower(email)=lower($1))
          OR ($2::text IS NOT NULL AND phone=$2 AND lower(name)=lower($3)))`,
    [email || null, phone || null, name],
  )).rows.filter((row) => row.id !== id);
  if (matches.length) throw new DiError(`Company member already exists: ${matches[0].name} (${matches[0].id}). Update that record instead.`);

  if (existing) {
    const { sql, values } = setClause(patch, FIELDS);
    return { member: (await tx.query(
      `UPDATE di.company_member SET ${sql} WHERE id=$${values.length + 1} AND tenant_id=di.current_tenant() RETURNING *`,
      [...values, id],
    )).rows[0], created: false };
  }
  const columns = Object.keys(patch);
  const member = (await tx.query(
    `INSERT INTO di.company_member (${columns.join(', ')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')}) RETURNING *`,
    columns.map((key) => patch[key]),
  )).rows[0];
  return { member, created: true };
}
