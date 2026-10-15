import { seedTenant } from '../core/seed.mjs';

/** A seeded company with the given name. Each test names the company it uses. */
export async function createTestCompany(db, name) {
  const { rows } = await db.query('INSERT INTO di.tenant (name) VALUES ($1) RETURNING id', [name]);
  await seedTenant(db, rows[0].id);
  await db.query('SELECT ensure_user_categories($1)', [rows[0].id]);
  return rows[0].id;
}

/**
 * A user of a test company in the one users table, placed in the company's starting category for
 * `access` (superadmin, department_head or user). Returns the user as the host sees a signed-in user.
 */
export async function createTestUser(db, tenantId, { id, username = null, name, access = 'user', passwordHash = null, email = null, department = null, position = null } = {}) {
  await db.query('SELECT ensure_user_categories($1)', [tenantId]);
  await db.query(`INSERT INTO users (id, company_tenant_id, category_id, display_name, username, password_hash, email, department, position)
    SELECT $1, $2, c.id, $3, $4, $5, $6, $7, $8 FROM user_category c
     WHERE c.company_tenant_id = $2 AND c.access = $9 ORDER BY c.created_at LIMIT 1`,
  [id, tenantId, name || username || id, username, passwordHash, email, department, position, access]);
  const { rows } = await db.query(`SELECT u.id, u.company_tenant_id, u.category_id, u.display_name, u.username, u.active, u.email,
      u.phone, u.position, u.department, u.location, u.notes, c.name AS category, c.access, c.limits
    FROM users u JOIN user_category c ON c.id = u.category_id WHERE u.id = $1`, [id]);
  return rows[0];
}
