import { randomUUID } from 'node:crypto';
import { VERSION } from './core.mjs';
export class ResearchStore {
  constructor(pool) { this.pool = pool; }
  async migrate() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS company_research_dossiers (
      id uuid PRIMARY KEY, place_id text, version text NOT NULL, seed jsonb NOT NULL, options jsonb NOT NULL DEFAULT '{}',
      status text NOT NULL DEFAULT 'queued', result jsonb, replay_input jsonb,
      error text, lease_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
      CREATE INDEX IF NOT EXISTS company_research_queue ON company_research_dossiers(status, created_at);
      CREATE INDEX IF NOT EXISTS company_research_cache ON company_research_dossiers(place_id, version, created_at);
      CREATE TABLE IF NOT EXISTS company_research_evidence (
        dossier_id uuid REFERENCES company_research_dossiers(id) ON DELETE CASCADE, id text NOT NULL, data jsonb NOT NULL, PRIMARY KEY(dossier_id,id));
      CREATE TABLE IF NOT EXISTS company_research_runs (
        dossier_id uuid REFERENCES company_research_dossiers(id) ON DELETE CASCADE, lane text NOT NULL, data jsonb NOT NULL, PRIMARY KEY(dossier_id,lane));
      CREATE TABLE IF NOT EXISTS company_research_events (
        seq bigserial PRIMARY KEY, dossier_id uuid REFERENCES company_research_dossiers(id) ON DELETE CASCADE, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS company_research_publications (
        token uuid PRIMARY KEY, dossier_id uuid NOT NULL UNIQUE REFERENCES company_research_dossiers(id) ON DELETE CASCADE,
        html text NOT NULL, name text NOT NULL, published_at timestamptz NOT NULL DEFAULT now());
      ALTER TABLE company_research_dossiers ADD COLUMN IF NOT EXISTS options jsonb NOT NULL DEFAULT '{}';
      ALTER TABLE company_research_dossiers ADD COLUMN IF NOT EXISTS lease_token uuid;
      CREATE TABLE IF NOT EXISTS company_research_newpages (id text PRIMARY KEY, name_norm text NOT NULL, data jsonb NOT NULL);`);
    try {
      await this.pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      await this.pool.query('CREATE INDEX IF NOT EXISTS company_research_newpages_trgm ON company_research_newpages USING gin(name_norm gin_trgm_ops)');
      this.trigrams = true;
    } catch { this.trigrams = false; }
  }
  async enqueue(seed, force = false, options = {}) {
    if (!force) {
      const old = await this.pool.query(`SELECT id,status FROM company_research_dossiers WHERE version=$1 AND seed=$2::jsonb AND options=$3::jsonb AND ((status IN ('queued','running')) OR (status='complete' AND created_at > now()-interval '30 days') OR (status='partial' AND created_at > now()-interval '1 day')) ORDER BY created_at DESC LIMIT 1`, [VERSION, JSON.stringify(seed), JSON.stringify(options)]);
      if (old.rows.length) return { ...old.rows[0], cached: true };
    }
    const id = randomUUID();
    await this.pool.query('INSERT INTO company_research_dossiers(id,place_id,version,seed,options) VALUES($1,$2,$3,$4,$5)', [id, seed.place_id || null, VERSION, seed, options]);
    await this.event(id, { type: 'queued', status: 'queued' }); return { id, status: 'queued', cached: false };
  }
  async claim() {
    // Claim and recovery cleanup are one atomic statement. The token fences
    // writes from a worker that resumes after another host takes its lease.
    const q = await this.pool.query(`WITH claimed AS (
      UPDATE company_research_dossiers SET status='running',error=NULL,lease_token=$1,lease_until=now()+interval '15 minutes',updated_at=now()
      WHERE id=(SELECT id FROM company_research_dossiers WHERE status='queued' OR (status='running' AND (lease_until IS NULL OR lease_until < now())) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id,seed,options,lease_token
    ), cleared_evidence AS (DELETE FROM company_research_evidence WHERE dossier_id IN (SELECT id FROM claimed) RETURNING dossier_id),
    cleared_runs AS (DELETE FROM company_research_runs WHERE dossier_id IN (SELECT id FROM claimed) RETURNING dossier_id)
    SELECT * FROM claimed`, [randomUUID()]);
    return q.rows[0];
  }
  async get(id) {
    const q = await this.pool.query('SELECT id,status,result,error,created_at,updated_at FROM company_research_dossiers WHERE id=$1', [id]);
    return q.rows[0] || null;
  }
  async list({ query = '', status = 'finished', limit = 20, offset = 0 } = {}) {
    if (!['all', 'finished', 'active', 'complete', 'partial', 'failed', 'needs_review'].includes(status)) throw new Error('Invalid research status filter');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 100000 || typeof query !== 'string' || query.length > 200) throw new Error('Invalid research pagination or query');
    const where = `($1='' OR position(lower($1) in lower(d.seed->>'name'))>0) AND ($2='all' OR ($2='finished' AND d.status NOT IN ('queued','running')) OR ($2='active' AND d.status IN ('queued','running')) OR d.status=$2)`;
    const [count, rows] = await Promise.all([
      this.pool.query(`SELECT count(*)::int AS total FROM company_research_dossiers d WHERE ${where}`, [query.trim(), status]),
      this.pool.query(`SELECT d.id,d.seed->>'name' AS name,d.seed->>'website' AS website,d.status,d.created_at AS "createdAt",d.updated_at AS "updatedAt",d.result IS NOT NULL AS "hasReport",d.result->'meta'->'durationMs' AS "durationMs",d.result->'scores'->'coverage' AS coverage,d.result->'meta'->>'version' AS version,p.token AS "publicationToken" FROM company_research_dossiers d LEFT JOIN company_research_publications p ON p.dossier_id=d.id WHERE ${where} ORDER BY d.created_at DESC,d.id DESC LIMIT $3 OFFSET $4`, [query.trim(), status, limit, offset]),
    ]);
    return { items: rows.rows, total: Number(count.rows[0].total), limit, offset };
  }
  async heartbeat(id, token) {
    const q = await this.pool.query("UPDATE company_research_dossiers SET lease_until=now()+interval '15 minutes' WHERE id=$1 AND status='running' AND ($2::uuid IS NULL OR (lease_token=$2 AND lease_until>now())) RETURNING id", [id, token || null]);
    return q.rows.length > 0;
  }
  async release(id, token) {
    if (!token) throw new Error('Lease token required to release a job');
    const q = await this.pool.query("UPDATE company_research_dossiers SET lease_until=now()-interval '1 second' WHERE id=$1 AND status='running' AND lease_token=$2 RETURNING id", [id, token]);
    return q.rows.length > 0;
  }
  async publish(id, html, name) {
    return (await this.pool.query(`INSERT INTO company_research_publications(token,dossier_id,html,name) VALUES($1,$2,$3,$4)
      ON CONFLICT(dossier_id) DO UPDATE SET html=excluded.html,name=excluded.name,published_at=now()
      RETURNING token,published_at`, [randomUUID(), id, html, name])).rows[0];
  }
  async publication(token) { return (await this.pool.query('SELECT html,name,published_at FROM company_research_publications WHERE token=$1', [token])).rows[0] || null; }
  async unpublish(id) { await this.pool.query('DELETE FROM company_research_publications WHERE dossier_id=$1', [id]); }
  async event(id, data, token) { await this.write('company_research_events', id, 'data', [data], token); }
  async events(id, after = 0) { return (await this.pool.query('SELECT seq,data FROM company_research_events WHERE dossier_id=$1 AND seq>$2 ORDER BY seq LIMIT 100', [id, after])).rows; }
  async write(table, id, columns, values, token) {
    const tokenIndex = values.length + 2;
    const q = await this.pool.query(`WITH owned AS (SELECT id FROM company_research_dossiers WHERE id=$1 AND ($${tokenIndex}::uuid IS NULL OR (status='running' AND lease_token=$${tokenIndex} AND lease_until>now())) FOR UPDATE)
      INSERT INTO ${table}(dossier_id,${columns}) SELECT id,${values.map((_, i) => `$${i + 2}`).join(',')} FROM owned
      ${table === 'company_research_events' ? '' : `ON CONFLICT(dossier_id,${table === 'company_research_evidence' ? 'id' : 'lane'}) DO UPDATE SET data=excluded.data`}
      RETURNING dossier_id`, [id, ...values, token || null]);
    if (token && !q.rows.length) throw new Error('Research job lease lost');
  }
  async evidence(id, e, token) { await this.write('company_research_evidence', id, 'id,data', [e.id, e], token); }
  async run(id, r, token) { await this.write('company_research_runs', id, 'lane,data', [r.lane, r], token); }
  async finish(id, outcome, token) {
    const { result, status, seed, identity, startedAt, webState, web } = outcome;
    const input = { seed, identity, startedAt, webState, web };
    const q = await this.pool.query("UPDATE company_research_dossiers SET status=$2,result=$3,replay_input=$4,error=NULL,lease_until=NULL,lease_token=NULL,updated_at=now() WHERE id=$1 AND ($5::uuid IS NULL OR (status='running' AND lease_token=$5 AND lease_until>now())) RETURNING id", [id, status, result, input, token || null]);
    if (token && !q.rows.length) throw new Error('Research job lease lost');
    await this.event(id, { type: 'finished', status });
  }
  async fail(id, error, token) {
    const q = await this.pool.query("UPDATE company_research_dossiers SET status='failed',error=$2,lease_until=NULL,lease_token=NULL,updated_at=now() WHERE id=$1 AND ($3::uuid IS NULL OR (status='running' AND lease_token=$3 AND lease_until>now())) RETURNING id", [id, error, token || null]);
    if (!q.rows.length) return false;
    await this.event(id, { type: 'finished', status: 'failed', error });
    return true;
  }
  async replayInput(id) {
    const q = await this.pool.query('SELECT replay_input,status FROM company_research_dossiers WHERE id=$1', [id]);
    if (!q.rows[0]?.replay_input) throw new Error('Dossier has no completed replay input');
    const evidence = (await this.pool.query('SELECT data FROM company_research_evidence WHERE dossier_id=$1 ORDER BY id', [id])).rows.map(r => r.data);
    const runs = (await this.pool.query('SELECT data FROM company_research_runs WHERE dossier_id=$1 ORDER BY lane', [id])).rows.map(r => r.data);
    return { ...q.rows[0].replay_input, evidence, runs };
  }
  async importDirectory(rows) {
    for (const row of rows) {
      if (!row.id || typeof row.name !== 'string' || row.name.length < 2) throw new Error('Each Newpages record requires id and name');
      const norm = directoryName(row.name);
      await this.pool.query('INSERT INTO company_research_newpages(id,name_norm,data) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET name_norm=excluded.name_norm,data=excluded.data', [String(row.id), norm, row]);
    }
    return { imported: rows.length, trigramMatching: this.trigrams };
  }
  async directoryCandidates(seed) {
    const name = directoryName(seed.name);
    const sql = this.trigrams
      ? 'SELECT data FROM company_research_newpages WHERE similarity(name_norm,$1)>0.3 ORDER BY similarity(name_norm,$1) DESC LIMIT 5'
      : 'SELECT data FROM company_research_newpages WHERE name_norm=$1 OR position($1 in name_norm)>0 ORDER BY id LIMIT 5';
    return (await this.pool.query(sql, [name])).rows.map(r => r.data);
  }
}
export function directoryName(name) { return name.toLowerCase().replace(/\b(sdn|bhd|berhad|sendirian|enterprise|trading)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
