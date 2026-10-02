import { readFile } from 'node:fs/promises';
import { connectDb, closeDb, getPool } from '../db.mjs';
import { ResearchStore } from './store.mjs';

const file = process.argv[2];
if (!file) throw new Error('Usage: node server/company-research/import-newpages.mjs <records.json>');
const rows = JSON.parse(await readFile(file, 'utf8'));
if (!Array.isArray(rows)) throw new Error('Newpages import must be a JSON array');
await connectDb();
try {
  const store = new ResearchStore(getPool()); await store.migrate();
  console.log(JSON.stringify(await store.importDirectory(rows)));
} finally { await closeDb(); }
