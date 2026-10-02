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
      CREATE TABLE IF NOT EXISTS company_research_newpages (id text PRIMARY KEY, name_norm text NOT NULL, data jsonb NOT NULL);`);
    try {
      await this.pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      await this.pool.query('CREATE INDEX IF NOT EXISTS company_research_newpages_trgm ON company_research_newpages USING gin(name_norm gin_trgm_ops)');
      this.trigrams = true;
    } catch { this.trigrams = false; }
  }
  async enqueue(seed, force = false, options = {}) {
    if (seed.place_id && !force) {
      const old = await this.pool.query(`SELECT id,status FROM company_research_dossiers WHERE place_id=$1 AND version=$2 AND seed=$3::jsonb AND options=$4::jsonb AND created_at > now()-interval '30 days' AND status IN ('queued','running','complete','partial') ORDER BY created_at DESC LIMIT 1`, [seed.place_id, VERSION, JSON.stringify(seed), JSON.stringify(options)]);
      if (old.rows.length) return { ...old.rows[0], cached: true };
    }
    const id = randomUUID();
    await this.pool.query('INSERT INTO company_research_dossiers(id,place_id,version,seed,options) VALUES($1,$2,$3,$4,$5)', [id, seed.place_id || null, VERSION, seed, options]);
    await this.event(id, { type: 'queued', status: 'queued' }); return { id, status: 'queued', cached: false };
  }
  async claim() {
    const q = await this.pool.query(`UPDATE company_research_dossiers SET status='running', lease_until=now()+interval '15 minutes', updated_at=now() WHERE id=(SELECT id FROM company_research_dossiers WHERE status='queued' OR (status='running' AND lease_until < now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,seed,options`);
    const job = q.rows[0];
    if (job) {
      // A recovered job starts over. Never combine stale findings with new ids.
      await this.pool.query('DELETE FROM company_research_evidence WHERE dossier_id=$1', [job.id]);
      await this.pool.query('DELETE FROM company_research_runs WHERE dossier_id=$1', [job.id]);
    }
    return job;
  }
  async get(id) {
    const q = await this.pool.query('SELECT id,status,result,error,created_at,updated_at FROM company_research_dossiers WHERE id=$1', [id]);
    return q.rows[0] || null;
  }
  async heartbeat(id) {
    await this.pool.query("UPDATE company_research_dossiers SET lease_until=now()+interval '15 minutes' WHERE id=$1 AND status='running'", [id]);
  }
  async publish(id, html, name) {
    return (await this.pool.query(`INSERT INTO company_research_publications(token,dossier_id,html,name) VALUES($1,$2,$3,$4)
      ON CONFLICT(dossier_id) DO UPDATE SET html=excluded.html,name=excluded.name,published_at=now()
      RETURNING token,published_at`, [randomUUID(), id, html, name])).rows[0];
  }
  async publication(token) { return (await this.pool.query('SELECT html,name,published_at FROM company_research_publications WHERE token=$1', [token])).rows[0] || null; }
  async unpublish(id) { await this.pool.query('DELETE FROM company_research_publications WHERE dossier_id=$1', [id]); }
  async event(id, data) { await this.pool.query('INSERT INTO company_research_events(dossier_id,data) VALUES($1,$2)', [id, data]); }
  async events(id, after = 0) { return (await this.pool.query('SELECT seq,data FROM company_research_events WHERE dossier_id=$1 AND seq>$2 ORDER BY seq LIMIT 100', [id, after])).rows; }
  async evidence(id, e) { await this.pool.query('INSERT INTO company_research_evidence(dossier_id,id,data) VALUES($1,$2,$3) ON CONFLICT(dossier_id,id) DO UPDATE SET data=excluded.data', [id, e.id, e]); }
  async run(id, r) { await this.pool.query('INSERT INTO company_research_runs(dossier_id,lane,data) VALUES($1,$2,$3) ON CONFLICT(dossier_id,lane) DO UPDATE SET data=excluded.data', [id, r.lane, r]); }
  async finish(id, outcome) {
    const { result, status, seed, identity, startedAt, webState, web } = outcome;
    const input = { seed, identity, startedAt, webState, web };
    await this.pool.query('UPDATE company_research_dossiers SET status=$2,result=$3,replay_input=$4,lease_until=NULL,updated_at=now() WHERE id=$1', [id, status, result, input]);
    await this.event(id, { type: 'finished', status });
  }
  async fail(id, error) {
    await this.pool.query("UPDATE company_research_dossiers SET status='failed',error=$2,lease_until=NULL,updated_at=now() WHERE id=$1", [id, error]);
    await this.event(id, { type: 'finished', status: 'failed', error });
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
