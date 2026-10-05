import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { PiSignalResearchRunner } from './runner.mjs';
import { researchCompanySignals } from './pipeline.mjs';

const seed = { company_uid: '1155.BURSA', ticker: '1155', exchange: 'BURSA', name: 'Maybank' };

for (const submitting of [true, false]) {
  test(`token limit ${submitting ? 'allows the pending submission' : 'still stops further research'}`, async () => {
    let listener;
    const runner = new PiSignalResearchRunner({ tokenBudget: 100, sessionFactory: async options => ({ session: {
      subscribe: callback => { listener = callback; return () => {}; },
      abort: async () => {}, dispose: () => {},
      prompt: async () => {
        listener({ type: 'message_end', message: { role: 'assistant', usage: { input: 101 },
          content: submitting ? [{ type: 'toolCall', name: 'submit_signals' }] : [] } });
        if (submitting) await options.customTools.find(t => t.name === 'submit_signals').execute('final', {
          signals: [], unknowns: ['Evidence is thin'], thesis: { summary: 'No supported catalysts found' },
        });
      },
    } }) });
    const result = await runner.run({ lane: 'S1', seed, evidence: [], tools: {} });
    assert.equal(result.status, submitting ? 'ok' : 'failed');
    assert.equal(result.error, submitting ? null : 'token_budget_exhausted');
    if (submitting) assert.deepEqual(result.findings.unknowns, ['Evidence is thin']);
  });
}

for (const accepted of [false, true]) {
  test(`successful discovery ${accepted ? 'with accepted research completes' : 'alone cannot complete research'}`, async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () => new Response('{}'));
    const events = [];
    try {
      const outcome = await researchCompanySignals({ seed,
        toolsFactory: () => ({ search: async () => ({ results: [] }), fetch_pages: async () => ({ results: [] }) }),
        runner: { run: async ({ lane }) => ({ lane, status: accepted ? 'ok' : 'failed',
          findings: accepted ? { signals: [], unknowns: ['No verified signals'] } : null,
          error: accepted ? null : 'token_budget_exhausted' }) },
        emit: async event => { events.push(event); },
      });
      assert.equal(outcome.status, accepted ? 'complete' : 'failed');
      assert.equal(events.at(-1).status, outcome.status);
      assert.equal(Boolean(outcome.error), !accepted);
    } finally {
      fetchMock.mock.restore();
    }
  });
}
