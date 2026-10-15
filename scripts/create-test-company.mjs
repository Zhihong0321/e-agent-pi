// Creates a company with its Superadmin through the same code the platform route uses.
// Usage: node scripts/create-test-company.mjs "<company name>" <username> <password> [company-code]
import pg from 'pg';
import { createCompany } from '../server/companies.mjs';

const [name, username, password, code] = process.argv.slice(2);
if (!name || !username || !password) throw new Error('Company name, username and password are required');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  console.log(JSON.stringify(await createCompany({ name, username, password, code }, pool)));
} finally { await pool.end(); }
