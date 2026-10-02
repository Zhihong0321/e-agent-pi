import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArchive, parsePsi, parseRdap, directoryAnchors, createMetadataLanes } from './metadata.mjs';

test('metadata parsers preserve measured values and distinguish truncated archive counts', () => {
  assert.deepEqual(parseRdap({ events: [{ eventAction: 'registration', eventDate: '2012-04-03T00:00:00Z' }] }), { createdOn: '2012-04-03' });
  assert.deepEqual(parseArchive([['timestamp'], ['20250102030405'], ['20110102030405']]), { snapshotCount: 2, firstCapture: '2011-01-02' });
  assert.deepEqual(parseArchive([['timestamp'], ...Array.from({ length: 10001 }, () => ['20250102030405'])]), { snapshotCountLowerBound: 10000, truncated: true });
  assert.equal(parsePsi({ lighthouseResult: { categories: { performance: { score: 0.45 } }, audits: {} } }).performance, 45);
});
test('Newpages candidates need an independent matching anchor; 011/012 do not collide', async () => {
  const seed = { name: 'Acme', phone: '011-2345 6789' };
  assert.deepEqual(directoryAnchors(seed, { phone: '012-345 6789' }), []);
  const lane = createMetadataLanes({ seed, directory: async () => [{ name: 'Acme', phone: '012-345 6789', url: 'https://newpages.com.my/wrong' }, { name: 'Acme', phone: '011-2345 6789', url: 'https://newpages.com.my/right' }] });
  const result = await lane.E(); assert.equal(result.directory.length, 2); assert.equal(result.evidence.length, 1); assert.match(result.evidence[0].url, /right/);
});
test('RDAP uses IANA bootstrap and PageSpeed key is excluded from stored evidence URLs', async () => {
  const lane = createMetadataLanes({ seed: { name: 'Acme', website: 'https://example.com/' }, psiKey: 'test-only-secret', pitchSignals: true, getJson: async url => {
    if (url.includes('dns.json')) return { url, data: { services: [[['com'], ['https://rdap.example/']]] } };
    if (url.includes('runPagespeed')) return { url, data: { lighthouseResult: { categories: { performance: { score: 0.5 } }, audits: {} } } };
    return { url, data: { events: [{ eventAction: 'registration', eventDate: '2001-01-01' }] } };
  } });
  assert.equal((await lane.B()).web.domain.createdOn, '2001-01-01');
  const psi = await lane.H(); assert.equal(psi.url.includes('test-only-secret'), false); assert.equal(psi.web.psi.performance, 50);
  assert.ok((await createMetadataLanes({ seed: { name: 'Acme' } }).H()).skipped);
});
