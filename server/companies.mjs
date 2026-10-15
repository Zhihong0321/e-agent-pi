// The only way a company comes into existence. A company always has a Superadmin login: the
// company, its default records and its first Superadmin are created in one transaction, so there
// is no moment, and no failure, that leaves a company nobody can administer.
import { randomUUID } from 'node:crypto';
import { getPool } from './db.mjs';
import { hashPassword } from './users.mjs';
import { seedTenantTx } from '../document_inteligence/core/seed.mjs';
import { isPlatformAgent } from './paths.mjs';

const USERNAME = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const COMPANY_CODE = /^[a-z0-9][a-z0-9-]{0,39}$/;

function clean({ name, code, username, password, displayName }) {
  const company = String(name ?? '').trim();
  if (!company || company.length > 200) throw new Error('Company name is required (up to 200 characters)');
  const companyCode = String(code ?? '').trim().toLowerCase() || null;
  if (companyCode && !COMPANY_CODE.test(companyCode)) throw new Error('Company code must contain 1–40 letters, digits or hyphens');
  const login = String(username ?? '').trim().toLowerCase();
  if (!USERNAME.test(login)) throw new Error('Superadmin username must contain 1–64 letters, digits, dots, underscores or hyphens');
  if (typeof password !== 'string' || password.length < 8) throw new Error('Superadmin password needs at least 8 characters');
  const display = String(displayName ?? '').trim() || login;
  if (display.length > 100) throw new Error('Superadmin display name is too long');
  return { company, companyCode, login, password, display };
}

/**
 * Creates a company with its first Superadmin. Returns ids only, never the password.
 * The company's sign-in code is `code`, or made from its name. A login is code + username + password.
 * @param {{ name: string, code?: string, username: string, password: string, displayName?: string }} input
 */
export async function createCompany(input, pool = getPool()) {
  const { company, companyCode, login, password, display } = clean(input);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const created = (await client.query('INSERT INTO di.tenant(name, code) VALUES($1, $2) RETURNING id, code', [company, companyCode])).rows[0];
    const tenantId = created.id;
    await client.query("SELECT set_config('di.tenant_id',$1,true)", [tenantId]);
    await seedTenantTx(client, tenantId);
    await client.query('SELECT ensure_user_categories($1)', [tenantId]);
    const userId = randomUUID();
    await client.query(
      `INSERT INTO users(id, company_tenant_id, category_id, display_name, username, password_hash)
        SELECT $1, $2, c.id, $3, $4, $5 FROM user_category c
         WHERE c.company_tenant_id = $2 AND c.access = 'superadmin' ORDER BY c.created_at LIMIT 1`,
      [userId, tenantId, display, login, hashPassword(password)],
    );
    // The Superadmin starts with every company agent; platform agents are never assignable.
    const agents = (await client.query('SELECT id FROM agents')).rows.map((row) => row.id).filter((id) => !isPlatformAgent(id));
    for (const agentId of agents) await client.query('INSERT INTO user_agents(user_id,agent_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [userId, agentId]);
    await client.query('COMMIT');
    return { tenantId, code: created.code, userId, username: login, agents: agents.length };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') throw new Error(error.constraint === 'tenant_code_key' ? 'Company code is already taken' : 'Username already exists');
    throw error;
  } finally {
    client.release();
  }
}

/** True when a company with this id exists. The operator may only act on a company that does. */
export async function companyExists(id, pool = getPool()) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return false;
  return (await pool.query('SELECT 1 FROM di.tenant WHERE id=$1 AND deleted_at IS NULL', [id])).rows.length > 0;
}

/** Every company with its count of active Superadmins; a company with 0 breaks the rule. */
export async function listCompanies(pool = getPool()) {
  const { rows } = await pool.query(`SELECT t.id, t.name, t.code, t.created_at AS "createdAt",
      (SELECT COUNT(*)::int FROM users u JOIN user_category c ON c.id = u.category_id
        WHERE u.company_tenant_id = t.id::text AND c.access = 'superadmin' AND u.active) AS superadmins,
      (SELECT COUNT(*)::int FROM users u WHERE u.company_tenant_id = t.id::text AND u.active
        AND u.username IS NOT NULL AND u.password_hash IS NOT NULL) AS logins
    FROM di.tenant t WHERE t.deleted_at IS NULL ORDER BY t.created_at`);
  return rows;
}

/** Companies that have no active Superadmin. Boot logs these; the invariant says the list is empty. */
export async function companiesWithoutSuperadmin(pool = getPool()) {
  return (await listCompanies(pool)).filter((company) => company.superadmins === 0);
}
