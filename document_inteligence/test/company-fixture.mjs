import { seedTenant } from '../core/seed.mjs';

/** A seeded company with the given name. Each test names the company it uses. */
export async function createTestCompany(db, name) {
  const { rows } = await db.query('INSERT INTO di.tenant (name) VALUES ($1) RETURNING id', [name]);
  await seedTenant(db, rows[0].id);
  return rows[0].id;
}
