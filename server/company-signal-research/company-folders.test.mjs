import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { SignalResearchStore } from './store.mjs';

test('Maybank listing aliases share one folder, all legacy reports, and future research', async () => {
  const db = new PGlite();
  try {
    const store = new SignalResearchStore({
      query: (sql, params) => params ? db.query(sql, params) : db.exec(sql).then(r => r.at(-1)),
    });
    await store.migrate();
    const legacy = [
      ['1155.BURSA', '1155', 'BURSA', 'Malayan Banking Berhad (Maybank)'],
      ['1155.KL.BURSA MALAYSIA', '1155.KL', 'BURSA MALAYSIA', 'Maybank Malaysia Berhad'],
      ['5347.BURSA', '5347', 'BURSA', 'Tenaga Nasional Berhad'],
      ['1155.NASDAQ', '1155', 'NASDAQ', 'Different listing'],
    ];
    for (const row of legacy) {
      await db.query('INSERT INTO company_signal_entities(uid,ticker,exchange,name) VALUES ($1,$2,$3,$4)', row);
    }
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (let i = 0; i < ids.length; i++) {
      await db.query(`INSERT INTO company_signal_dossiers
        (id,company_uid,version,sequence,status,seed,result,created_at)
        VALUES ($1,$2,'test',$3,'complete','{}',$4,$5)`,
      [ids[i], legacy[i === 2 ? 1 : 0][0], i === 1 ? 2 : 1,
        { thesis: { bias: i === 2 ? 'bullish' : 'neutral', conviction: 0.5 } },
        `2026-10-0${i + 1}T00:00:00Z`]);
    }
    const companies = await store.listCompanies();
    assert.equal(companies.length, 3);
    const maybank = companies.find(c => c.uid === '1155.BURSA');
    assert.equal(maybank.report_count, 3);
    assert.equal(maybank.completed_count, 3);
    assert.equal(maybank.latest_report.id, ids[2]);
    assert.equal(maybank.ticker, '1155');
    for (const uid of ['1155.BURSA', '1155.KL.BURSA MALAYSIA']) {
      const detail = await store.getCompanyWithReports(uid);
      assert.equal(detail.entity.uid, '1155.BURSA');
      assert.deepEqual(detail.reports.map(r => r.id), [...ids].reverse());
      assert.equal((await store.getHistory(uid, 10)).length, 3);
    }
    const fresh = await store.enqueue({ company_uid: 'ARBITRARY-MAYBANK',
      ticker: ' 1155.kl ', exchange: ' bursa malaysia ', name: 'Maybank' }, true);
    assert.equal(fresh.sequence, 4);
    const dossier = await store.get(fresh.id);
    assert.equal(dossier.company_uid, '1155.BURSA');
    assert.equal(dossier.seed.company_uid, '1155.BURSA');
    assert.equal(dossier.previous_dossier_id, ids[2]);
    const duplicate = await store.enqueue({ company_uid: 'ANOTHER-UID',
      ticker: '1155', exchange: 'MYX', name: 'Maybank' }, true);
    assert.equal(duplicate.id, fresh.id);
    assert.equal((await store.listCompanies()).find(c => c.uid === '1155.BURSA').report_count, 4);
    assert.equal((await store.getCompanyWithReports('1155.KL.BURSA MALAYSIA')).reports.length, 4);
    assert.equal((await store.listCompanies({ query: 'Maybank', limit: 1 })).length, 1);
    assert.equal((await store.getCompanyWithReports('1155.NASDAQ')).reports.length, 0);
    assert.equal(await store.getCompanyWithReports('MISSING'), null);
  } finally {
    await db.close();
  }
});
