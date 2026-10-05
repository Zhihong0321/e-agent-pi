import { randomUUID } from 'node:crypto';
import { VERSION } from './core.mjs';

export class SignalResearchStore {
  constructor(pool) {
    this.pool = pool;
  }

  async migrate() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS company_signal_entities (
        uid TEXT PRIMARY KEY,
        ticker TEXT NOT NULL,
        exchange TEXT NOT NULL,
        name TEXT NOT NULL,
        sector TEXT,
        metadata JSONB NOT NULL DEFAULT '{}',
        last_researched_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS company_signal_entities_ticker ON company_signal_entities(ticker, exchange);

      CREATE TABLE IF NOT EXISTS company_signal_dossiers (
        id UUID PRIMARY KEY,
        company_uid TEXT NOT NULL REFERENCES company_signal_entities(uid) ON DELETE CASCADE,
        version TEXT NOT NULL,
        sequence INT NOT NULL DEFAULT 1,
        previous_dossier_id UUID,
        status TEXT NOT NULL DEFAULT 'queued',
        seed JSONB NOT NULL,
        options JSONB NOT NULL DEFAULT '{}',
        result JSONB,
        error TEXT,
        lease_token UUID,
        lease_until TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS company_signal_queue ON company_signal_dossiers(status, created_at);
      CREATE INDEX IF NOT EXISTS company_signal_uid ON company_signal_dossiers(company_uid, created_at DESC);

      CREATE TABLE IF NOT EXISTS company_signal_evidence (
        dossier_id UUID REFERENCES company_signal_dossiers(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        data JSONB NOT NULL,
        PRIMARY KEY (dossier_id, id)
      );

      CREATE TABLE IF NOT EXISTS company_signal_runs (
        dossier_id UUID REFERENCES company_signal_dossiers(id) ON DELETE CASCADE,
        lane TEXT NOT NULL,
        data JSONB NOT NULL,
        PRIMARY KEY (dossier_id, lane)
      );

      CREATE TABLE IF NOT EXISTS company_signal_events (
        seq BIGSERIAL PRIMARY KEY,
        dossier_id UUID REFERENCES company_signal_dossiers(id) ON DELETE CASCADE,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS company_signal_catalysts (
        id UUID PRIMARY KEY,
        company_uid TEXT NOT NULL REFERENCES company_signal_entities(uid) ON DELETE CASCADE,
        dossier_id UUID NOT NULL REFERENCES company_signal_dossiers(id) ON DELETE CASCADE,
        category TEXT NOT NULL,
        impact TEXT NOT NULL,
        event_date DATE,
        headline TEXT NOT NULL,
        summary TEXT NOT NULL,
        quote TEXT NOT NULL,
        source_url TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS company_signal_catalysts_uid ON company_signal_catalysts(company_uid, event_date DESC);
    `);
  }

  async getOrCreateEntity(seed) {
    const uid = seed.company_uid.trim().toUpperCase();
    const ticker = seed.ticker.trim().toUpperCase();
    const exchange = seed.exchange.trim().toUpperCase();
    const name = seed.name.trim();
    const sector = seed.sector?.trim() || null;

    const res = await this.pool.query(`
      INSERT INTO company_signal_entities(uid, ticker, exchange, name, sector)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (uid) DO UPDATE
      SET name = excluded.name,
          sector = COALESCE(excluded.sector, company_signal_entities.sector),
          updated_at = NOW()
      RETURNING *
    `, [uid, ticker, exchange, name, sector]);

    return res.rows[0];
  }

  async enqueue(seed, force = false, options = {}) {
    const entity = await this.getOrCreateEntity(seed);
    const uid = entity.uid;

    // Check if there is already an active job running for this entity
    const active = await this.pool.query(`
      SELECT id, status, sequence FROM company_signal_dossiers
      WHERE company_uid = $1 AND status IN ('queued', 'running')
      ORDER BY created_at DESC LIMIT 1
    `, [uid]);
    if (active.rows.length) {
      return { ...active.rows[0], cached: true };
    }

    // Check recent completed report if not forcing fresh run (e.g. 1 hour cache)
    if (!force) {
      const recent = await this.pool.query(`
        SELECT id, status, sequence FROM company_signal_dossiers
        WHERE company_uid = $1 AND status = 'complete' AND created_at > NOW() - INTERVAL '1 hour'
        ORDER BY created_at DESC LIMIT 1
      `, [uid]);
      if (recent.rows.length) {
        return { ...recent.rows[0], cached: true };
      }
    }

    // Determine sequence number by finding the latest completed dossier
    const prev = await this.pool.query(`
      SELECT id, sequence FROM company_signal_dossiers
      WHERE company_uid = $1 AND status = 'complete'
      ORDER BY sequence DESC, created_at DESC LIMIT 1
    `, [uid]);

    const sequence = prev.rows.length ? Number(prev.rows[0].sequence) + 1 : 1;
    const previousDossierId = prev.rows.length ? prev.rows[0].id : null;

    const id = randomUUID();
    await this.pool.query(`
      INSERT INTO company_signal_dossiers (
        id, company_uid, version, sequence, previous_dossier_id, seed, options
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [id, uid, VERSION, sequence, previousDossierId, seed, options]);

    await this.event(id, { type: 'queued', status: 'queued', sequence });
    return { id, status: 'queued', sequence, cached: false };
  }

  async claim() {
    const q = await this.pool.query(`
      WITH claimed AS (
        UPDATE company_signal_dossiers
        SET status = 'running',
            error = NULL,
            lease_token = $1,
            lease_until = NOW() + INTERVAL '15 minutes',
            updated_at = NOW()
        WHERE id = (
          SELECT id FROM company_signal_dossiers
          WHERE status = 'queued'
             OR (status = 'running' AND (lease_until IS NULL OR lease_until < NOW()))
          ORDER BY created_at, id
          FOR UPDATE SKIP LOCKED LIMIT 1
        )
        RETURNING id, company_uid, seed, sequence, previous_dossier_id, options, lease_token
      ), cleared_evidence AS (
        DELETE FROM company_signal_evidence WHERE dossier_id IN (SELECT id FROM claimed) RETURNING dossier_id
      ), cleared_runs AS (
        DELETE FROM company_signal_runs WHERE dossier_id IN (SELECT id FROM claimed) RETURNING dossier_id
      )
      SELECT * FROM claimed
    `, [randomUUID()]);
    return q.rows[0];
  }

  async heartbeat(id, token) {
    const q = await this.pool.query(`
      UPDATE company_signal_dossiers
      SET lease_until = NOW() + INTERVAL '15 minutes'
      WHERE id = $1 AND status = 'running'
        AND ($2::UUID IS NULL OR (lease_token = $2 AND lease_until > NOW()))
      RETURNING id
    `, [id, token || null]);
    return q.rows.length > 0;
  }

  async release(id, token) {
    if (!token) throw new Error('Lease token required to release a job');
    const q = await this.pool.query(`
      UPDATE company_signal_dossiers
      SET lease_until = NOW() - INTERVAL '1 second'
      WHERE id = $1 AND status = 'running' AND lease_token = $2
      RETURNING id
    `, [id, token]);
    return q.rows.length > 0;
  }

  async get(id) {
    const q = await this.pool.query(`
      SELECT d.*, e.name, e.ticker, e.exchange, e.sector
      FROM company_signal_dossiers d
      JOIN company_signal_entities e ON d.company_uid = e.uid
      WHERE d.id = $1
    `, [id]);
    return q.rows[0] || null;
  }

  async getHistory(companyUid, limit = 5) {
    const q = await this.pool.query(`
      SELECT id, sequence, status, result, created_at, updated_at
      FROM company_signal_dossiers
      WHERE company_uid = $1 AND status = 'complete'
      ORDER BY sequence DESC, created_at DESC
      LIMIT $2
    `, [companyUid, limit]);
    return q.rows;
  }

  async list({ query = '', status = 'all', limit = 20, offset = 0 } = {}) {
    const where = `
      ($1 = '' OR POSITION(LOWER($1) IN LOWER(e.name)) > 0 OR POSITION(LOWER($1) IN LOWER(e.ticker)) > 0 OR POSITION(LOWER($1) IN LOWER(e.uid)) > 0)
      AND ($2 = 'all' OR ($2 = 'finished' AND d.status NOT IN ('queued', 'running')) OR ($2 = 'active' AND d.status IN ('queued', 'running')) OR d.status = $2)
    `;
    const [count, rows] = await Promise.all([
      this.pool.query(`
        SELECT count(*)::int AS total
        FROM company_signal_dossiers d
        JOIN company_signal_entities e ON d.company_uid = e.uid
        WHERE ${where}
      `, [query.trim(), status]),
      this.pool.query(`
        SELECT d.id, d.company_uid, e.name, e.ticker, e.exchange, e.sector,
               d.sequence, d.status, d.created_at AS "createdAt", d.updated_at AS "updatedAt",
               d.result IS NOT NULL AS "hasReport",
               d.result->'thesis'->>'bias' AS bias,
               d.result->'thesis'->>'conviction' AS conviction,
               d.result->'counts'->>'total' AS "signalsCount"
        FROM company_signal_dossiers d
        JOIN company_signal_entities e ON d.company_uid = e.uid
        WHERE ${where}
        ORDER BY d.created_at DESC, d.id DESC
        LIMIT $3 OFFSET $4
      `, [query.trim(), status, limit, offset]),
    ]);
    return { items: rows.rows, total: Number(count.rows[0].total), limit, offset };
  }

  async listCompanies({ query = '', limit = 50, offset = 0 } = {}) {
    const where = `($1 = '' OR POSITION(LOWER($1) IN LOWER(e.name)) > 0 OR POSITION(LOWER($1) IN LOWER(e.ticker)) > 0 OR POSITION(LOWER($1) IN LOWER(e.uid)) > 0)`;
    const q = await this.pool.query(`
      SELECT 
        e.uid, e.ticker, e.exchange, e.name, e.sector, e.last_researched_at, e.created_at, e.updated_at,
        COUNT(d.id)::int AS report_count,
        COUNT(CASE WHEN d.status = 'complete' THEN 1 END)::int AS completed_count,
        MAX(d.created_at) AS latest_report_at,
        (
          SELECT jsonb_build_object(
            'id', d2.id,
            'sequence', d2.sequence,
            'status', d2.status,
            'bias', d2.result->'thesis'->>'bias',
            'conviction', (d2.result->'thesis'->>'conviction')::numeric,
            'trajectory', d2.result->'trend'->>'trajectory',
            'summary', COALESCE(d2.result->>'delta_summary', d2.result->'thesis'->>'summary'),
            'signalsCount', (d2.result->'counts'->>'total')::int,
            'currentPrice', (d2.result->'market_data'->>'currentPrice')::numeric,
            'sevenDayChangePercent', (d2.result->'market_data'->>'sevenDayChangePercent')::numeric,
            'createdAt', d2.created_at
          )
          FROM company_signal_dossiers d2
          WHERE d2.company_uid = e.uid AND d2.status = 'complete'
          ORDER BY d2.sequence DESC, d2.created_at DESC
          LIMIT 1
        ) AS latest_report
      FROM company_signal_entities e
      LEFT JOIN company_signal_dossiers d ON e.uid = d.company_uid
      WHERE ${where}
      GROUP BY e.uid, e.ticker, e.exchange, e.name, e.sector, e.last_researched_at, e.created_at, e.updated_at
      ORDER BY COALESCE(e.last_researched_at, e.created_at) DESC
      LIMIT $2 OFFSET $3
    `, [query.trim(), limit, offset]);

    return q.rows;
  }

  async getCompanyWithReports(companyUid) {
    const uid = companyUid.trim().toUpperCase();
    const entityRes = await this.pool.query(`
      SELECT * FROM company_signal_entities WHERE uid = $1
    `, [uid]);
    if (!entityRes.rows.length) return null;

    const reportsRes = await this.pool.query(`
      SELECT d.id, d.company_uid, d.version, d.sequence, d.previous_dossier_id, d.status, d.seed, d.result, d.error, d.created_at, d.updated_at
      FROM company_signal_dossiers d
      WHERE d.company_uid = $1
      ORDER BY d.sequence DESC, d.created_at DESC
    `, [uid]);

    return {
      entity: entityRes.rows[0],
      reports: reportsRes.rows,
    };
  }

  async event(id, data, token) {
    await this.write('company_signal_events', id, 'data', [data], token);
  }

  async events(id, after = 0) {
    return (await this.pool.query(`
      SELECT seq, data FROM company_signal_events
      WHERE dossier_id = $1 AND seq > $2
      ORDER BY seq LIMIT 100
    `, [id, after])).rows;
  }

  async evidence(id, e, token) {
    await this.write('company_signal_evidence', id, 'id, data', [e.id, e], token);
  }

  async run(id, r, token) {
    await this.write('company_signal_runs', id, 'lane, data', [r.lane, r], token);
  }

  async write(table, id, columns, values, token) {
    const tokenIndex = values.length + 2;
    const q = await this.pool.query(`
      WITH owned AS (
        SELECT id FROM company_signal_dossiers
        WHERE id = $1 AND ($${tokenIndex}::UUID IS NULL OR (status = 'running' AND lease_token = $${tokenIndex} AND lease_until > NOW()))
        FOR UPDATE
      )
      INSERT INTO ${table}(dossier_id, ${columns})
      SELECT id, ${values.map((_, i) => `$${i + 2}`).join(',')} FROM owned
      ${table === 'company_signal_events' ? '' : `ON CONFLICT(dossier_id, ${table === 'company_signal_evidence' ? 'id' : 'lane'}) DO UPDATE SET data = EXCLUDED.data`}
      RETURNING dossier_id
    `, [id, ...values, token || null]);
    if (token && !q.rows.length) throw new Error('Research job lease lost');
  }

  async finish(id, outcome, token) {
    const { result, status, seed } = outcome;
    const q = await this.pool.query(`
      UPDATE company_signal_dossiers
      SET status = $2,
          result = $3,
          error = NULL,
          lease_until = NULL,
          lease_token = NULL,
          updated_at = NOW()
      WHERE id = $1 AND ($4::UUID IS NULL OR (status = 'running' AND lease_token = $4 AND lease_until > NOW()))
      RETURNING id, company_uid
    `, [id, status, result, token || null]);

    if (token && !q.rows.length) throw new Error('Research job lease lost');

    // Update entity last_researched_at
    await this.pool.query(`
      UPDATE company_signal_entities
      SET last_researched_at = NOW(), updated_at = NOW()
      WHERE uid = $1
    `, [seed.company_uid]);

    // Insert discrete catalysts for fast lookups & timeline queries
    if (Array.isArray(result?.signals)) {
      for (const sig of result.signals) {
        await this.pool.query(`
          INSERT INTO company_signal_catalysts (
            id, company_uid, dossier_id, category, impact, event_date, headline, summary, quote, source_url
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT (id) DO NOTHING
        `, [
          randomUUID(),
          seed.company_uid,
          id,
          sig.category,
          sig.impact,
          sig.event_date || null,
          sig.headline,
          sig.summary,
          sig.quote,
          sig.source?.url || null,
        ]);
      }
    }

    await this.event(id, { type: 'finished', status });
  }

  async fail(id, error, token) {
    const q = await this.pool.query(`
      UPDATE company_signal_dossiers
      SET status = 'failed',
          error = $2,
          lease_until = NULL,
          lease_token = NULL,
          updated_at = NOW()
      WHERE id = $1 AND ($3::UUID IS NULL OR (status = 'running' AND lease_token = $3 AND lease_until > NOW()))
      RETURNING id
    `, [id, error, token || null]);

    if (!q.rows.length) return false;
    await this.event(id, { type: 'finished', status: 'failed', error });
    return true;
  }

  async listCatalysts(companyUid, { limit = 50 } = {}) {
    const q = await this.pool.query(`
      SELECT c.*, d.sequence
      FROM company_signal_catalysts c
      JOIN company_signal_dossiers d ON c.dossier_id = d.id
      WHERE c.company_uid = $1
      ORDER BY c.event_date DESC NULLS LAST, c.created_at DESC
      LIMIT $2
    `, [companyUid, limit]);
    return q.rows;
  }
}
