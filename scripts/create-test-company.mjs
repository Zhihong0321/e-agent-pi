import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { pgAdapter } from '../document_inteligence/core/db.mjs';
import { seedTenant } from '../document_inteligence/core/seed.mjs';
import { hashPassword } from '../server/users.mjs';

const [name, username, password] = process.argv.slice(2);
if (!name || !username || !password) throw new Error('Company name, username and password are required');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const tenantId = (await pool.query('INSERT INTO di.tenant(name) VALUES($1) RETURNING id', [name])).rows[0].id;
  await seedTenant(pgAdapter(pool), tenantId);
  const userId = randomUUID();
  await pool.query("INSERT INTO users(id,username,display_name,password_hash,role,company_tenant_id) VALUES($1,$2,$3,$4,'admin',$5)", [userId, username, name, hashPassword(password), tenantId]);
  await pool.query('INSERT INTO user_agents SELECT $1,id FROM agents', [userId]);
  console.log(JSON.stringify({ tenantId, userId, username }));
} finally { await pool.end(); }
