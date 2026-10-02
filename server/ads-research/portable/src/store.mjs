import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const nowIso = () => new Date().toISOString();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ads (
  id             INTEGER PRIMARY KEY,
  topic          TEXT NOT NULL,
  channel        TEXT NOT NULL,
  native_id      TEXT NOT NULL,
  advertiser     TEXT,
  started        TEXT,
  copy           TEXT,
  links          TEXT,
  shot           TEXT,
  extra          TEXT,
  queries        TEXT,
  first_seen     TEXT NOT NULL,
  last_seen      TEXT NOT NULL,
  times_seen     INTEGER NOT NULL DEFAULT 1,
  active         INTEGER NOT NULL DEFAULT 1,
  filter_version INTEGER NOT NULL DEFAULT 0,
  relevant       INTEGER NOT NULL DEFAULT 0,
  tier           TEXT,
  lang           TEXT,
  angles         TEXT,
  UNIQUE(topic, channel, native_id)
);
CREATE INDEX IF NOT EXISTS ads_topic_rel ON ads(topic, relevant);
CREATE INDEX IF NOT EXISTS ads_adv ON ads(topic, advertiser);

CREATE TABLE IF NOT EXISTS analysis (
  ad_id      INTEGER PRIMARY KEY REFERENCES ads(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  provider   TEXT,
  json       TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY,
  topic       TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  stats       TEXT
);

CREATE TABLE IF NOT EXISTS kv (
  k          TEXT PRIMARY KEY,
  v          TEXT,
  updated_at TEXT
);
`;

export class Store {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  close() { this.db.close(); }

  // ---- ads ---------------------------------------------------------------
  /** Insert a newly-seen ad, or touch an existing one. Returns 'new' | 'seen'. */
  upsertAd(topic, channel, ad) {
    const ts = nowIso();
    const row = this.db.prepare(
      `SELECT id, queries FROM ads WHERE topic=? AND channel=? AND native_id=?`
    ).get(topic, channel, String(ad.native_id));

    if (row) {
      // merge the query list so we know every search that surfaced this ad
      const prev = new Set(JSON.parse(row.queries || '[]'));
      for (const q of ad.queries || []) prev.add(q);
      this.db.prepare(
        `UPDATE ads SET last_seen=?, times_seen=times_seen+1, active=1, queries=?,
           copy=COALESCE(NULLIF(?,''), copy), shot=COALESCE(?, shot)
         WHERE id=?`
      ).run(ts, JSON.stringify([...prev]), ad.copy ?? '', ad.shot ?? null, row.id);
      return 'seen';
    }

    this.db.prepare(
      `INSERT INTO ads (topic, channel, native_id, advertiser, started, copy, links, shot,
                        extra, queries, first_seen, last_seen)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      topic, channel, String(ad.native_id), ad.advertiser ?? null, ad.started ?? null,
      ad.copy ?? '', JSON.stringify(ad.links ?? []), ad.shot ?? null,
      JSON.stringify(ad.extra ?? {}), JSON.stringify(ad.queries ?? []), ts, ts
    );
    return 'new';
  }

  /** Ads present in the DB but not seen in this sweep are marked inactive. */
  markInactive(topic, channel, sweepStartIso) {
    return this.db.prepare(
      `UPDATE ads SET active=0 WHERE topic=? AND channel=? AND last_seen < ? AND active=1`
    ).run(topic, channel, sweepStartIso).changes;
  }

  /** Native ids already stored for a channel — lets scrapers skip expensive re-fetches. */
  knownIds(topic, channel) {
    return new Set(this.db.prepare(
      `SELECT native_id FROM ads WHERE topic=? AND channel=?`
    ).all(topic, channel).map(r => r.native_id));
  }

  setShot(id, shot) {
    this.db.prepare(`UPDATE ads SET shot=? WHERE id=?`).run(shot, id);
  }

  adsNeedingShot(topic) {
    return this.db.prepare(
      `SELECT id, channel, native_id FROM ads WHERE topic=? AND shot IS NULL`
    ).all(topic);
  }

  /** Overwrite copy + merge extra fields for one ad, keyed by native id.
   *  Unlike upsertAd's COALESCE merge (used during a live sweep), this is an
   *  authoritative overwrite — the whole point of a re-run extract pass is to
   *  fix previously-wrong copy, not defer to what's already stored. */
  mergeExtraction(topic, channel, nativeId, { copy, extraPatch }) {
    const row = this.db.prepare(
      `SELECT id, extra FROM ads WHERE topic=? AND channel=? AND native_id=?`
    ).get(topic, channel, String(nativeId));
    if (!row) return false;
    const extra = { ...JSON.parse(row.extra || '{}'), ...extraPatch };
    this.db.prepare(`UPDATE ads SET copy=?, extra=? WHERE id=?`).run(copy ?? '', JSON.stringify(extra), row.id);
    return true;
  }

  /** Hard-assertion inputs for `cli.mjs verify`. Distinguishes "produced
   *  nothing" from "produced bot-wall/error-page text" — a smoke test that
   *  only checks non-empty copy has passed on a Google error page before. */
  verifyStats(topic, copyMinLen = 20) {
    const one = (sql, ...a) => this.db.prepare(sql).get(topic, ...a).c;
    const errorPatterns = ['%unusual traffic%', '%not a robot%', '%recaptcha%', '%verify you are human%'];
    let errorPageCopy = 0;
    for (const pat of errorPatterns) {
      errorPageCopy += this.db.prepare(`SELECT COUNT(*) c FROM ads WHERE topic=? AND copy LIKE ?`).get(topic, pat).c;
    }
    return {
      total: one(`SELECT COUNT(*) c FROM ads WHERE topic=?`),
      withImage: one(`SELECT COUNT(*) c FROM ads WHERE topic=? AND shot IS NOT NULL`),
      withCopy: one(`SELECT COUNT(*) c FROM ads WHERE topic=? AND length(copy) >= ?`, copyMinLen),
      errorPageCopy,
      byChannel: this.db.prepare(
        `SELECT channel, COUNT(*) c,
                SUM(CASE WHEN shot IS NOT NULL THEN 1 ELSE 0 END) img,
                SUM(CASE WHEN length(copy) >= ? THEN 1 ELSE 0 END) cp
         FROM ads WHERE topic=? GROUP BY channel`
      ).all(copyMinLen, topic),
    };
  }

  setFilter(id, { filterVersion, relevant, tier, lang, angles }) {
    this.db.prepare(
      `UPDATE ads SET filter_version=?, relevant=?, tier=?, lang=?, angles=? WHERE id=?`
    ).run(filterVersion, relevant ? 1 : 0, tier ?? null, lang ?? null, JSON.stringify(angles ?? []), id);
  }

  adsNeedingFilter(topic, filterVersion) {
    return this.db.prepare(
      `SELECT * FROM ads WHERE topic=? AND filter_version < ?`
    ).all(topic, filterVersion);
  }

  /** The incremental core: only relevant ads with missing/stale analysis. */
  adsNeedingAnalysis(topic, analysisVersion) {
    return this.db.prepare(
      `SELECT a.* FROM ads a
       LEFT JOIN analysis an ON an.ad_id = a.id
       WHERE a.topic=? AND a.relevant=1
         AND (an.ad_id IS NULL OR an.version < ?)`
    ).all(topic, analysisVersion);
  }

  saveAnalysis(adId, version, provider, obj) {
    this.db.prepare(
      `INSERT INTO analysis (ad_id, version, provider, json, created_at) VALUES (?,?,?,?,?)
       ON CONFLICT(ad_id) DO UPDATE SET version=excluded.version, provider=excluded.provider,
         json=excluded.json, created_at=excluded.created_at`
    ).run(adId, version, provider ?? null, JSON.stringify(obj), nowIso());
  }

  relevantAds(topic) {
    return this.db.prepare(
      `SELECT a.*, an.json AS analysis_json
       FROM ads a LEFT JOIN analysis an ON an.ad_id=a.id
       WHERE a.topic=? AND a.relevant=1
       ORDER BY a.advertiser COLLATE NOCASE, a.first_seen`
    ).all(topic);
  }

  /** Ads first seen since a timestamp — powers the "what's new" report section. */
  newSince(topic, iso) {
    return this.db.prepare(
      `SELECT * FROM ads WHERE topic=? AND relevant=1 AND first_seen >= ? ORDER BY first_seen DESC`
    ).all(topic, iso);
  }

  /** Longevity: how long each ad has been observed running. */
  longRunning(topic, limit = 25) {
    return this.db.prepare(
      `SELECT advertiser, native_id, started, first_seen, last_seen, copy,
              julianday(last_seen) - julianday(first_seen) AS days_tracked
       FROM ads WHERE topic=? AND relevant=1
       ORDER BY days_tracked DESC, times_seen DESC LIMIT ?`
    ).all(topic, limit);
  }

  stats(topic, analysisVersion) {
    const one = (sql, ...a) => this.db.prepare(sql).get(topic, ...a);
    return {
      total: one(`SELECT COUNT(*) c FROM ads WHERE topic=?`).c,
      relevant: one(`SELECT COUNT(*) c FROM ads WHERE topic=? AND relevant=1`).c,
      active: one(`SELECT COUNT(*) c FROM ads WHERE topic=? AND relevant=1 AND active=1`).c,
      advertisers: one(`SELECT COUNT(DISTINCT advertiser) c FROM ads WHERE topic=? AND relevant=1`).c,
      analysed: one(
        `SELECT COUNT(*) c FROM ads a JOIN analysis an ON an.ad_id=a.id
         WHERE a.topic=? AND a.relevant=1 AND an.version >= ?`, analysisVersion).c,
      byChannel: this.db.prepare(
        `SELECT channel, COUNT(*) c FROM ads WHERE topic=? AND relevant=1 GROUP BY channel`
      ).all(topic),
    };
  }

  // ---- runs & kv ---------------------------------------------------------
  startRun(topic) {
    return this.db.prepare(`INSERT INTO runs (topic, started_at) VALUES (?,?)`)
      .run(topic, nowIso()).lastInsertRowid;
  }
  finishRun(id, stats) {
    this.db.prepare(`UPDATE runs SET finished_at=?, stats=? WHERE id=?`)
      .run(nowIso(), JSON.stringify(stats), id);
  }
  lastRunBefore(topic) {
    const r = this.db.prepare(
      `SELECT started_at FROM runs WHERE topic=? AND finished_at IS NOT NULL
       ORDER BY id DESC LIMIT 1 OFFSET 0`
    ).get(topic);
    return r?.started_at ?? null;
  }

  kvGet(k, maxAgeMs = Infinity) {
    const r = this.db.prepare(`SELECT v, updated_at FROM kv WHERE k=?`).get(k);
    if (!r) return null;
    if (Date.now() - Date.parse(r.updated_at) > maxAgeMs) return null;
    try { return JSON.parse(r.v); } catch { return null; }
  }
  kvSet(k, v) {
    this.db.prepare(
      `INSERT INTO kv (k,v,updated_at) VALUES (?,?,?)
       ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at`
    ).run(k, JSON.stringify(v), nowIso());
  }
}
