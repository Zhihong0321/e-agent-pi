import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { applyQueueLimits, parseSavedLimits, queueReport, validateQueueLimits } from './limits.mjs';
import { llmGate, registerProviderBase, resetLlmGatesForTests } from './llm-gate.mjs';
import { piGate, resetPiGateForTests } from './pi-gate.mjs';

beforeEach(() => {
  resetLlmGatesForTests();
  resetPiGateForTests({ maxConcurrent: 3 });
  registerProviderBase('cavoti', 'https://cavoti.com/v1');
  registerProviderBase('glm53', 'https://vectide.cn/v1');
});

test('validation accepts whole numbers and "no cap", and explains anything else', () => {
  assert.deepEqual(validateQueueLimits({ maxPi: '5', providers: { cavoti: { maxConcurrent: '4', perMinute: '' }, glm53: {} } }),
    { maxPi: 5, providers: { cavoti: { maxConcurrent: 4, perMinute: null } } });
  assert.deepEqual(validateQueueLimits({}), { maxPi: null, providers: {} });
  assert.throws(() => validateQueueLimits({ maxPi: 0 }), /Max Pi at once must be a whole number/);
  assert.throws(() => validateQueueLimits({ maxPi: 2.5 }), /whole number/);
  assert.throws(() => validateQueueLimits({ providers: { cavoti: { perMinute: -1 } } }), /cavoti: calls per minute/);
});

test('a damaged saved value means no overrides, not a crash', () => {
  assert.deepEqual(parseSavedLimits('{not json'), { maxPi: null, providers: {} });
  assert.deepEqual(parseSavedLimits(null), { maxPi: null, providers: {} });
});

test('limits reach the live gates, and removing them lifts the cap again', async () => {
  applyQueueLimits({ maxPi: 1, providers: { cavoti: { maxConcurrent: 2, perMinute: 30 } } }, { defaultMaxPi: 3 });
  assert.equal(piGate.stats().maxConcurrent, 1);
  assert.equal(llmGate('cavoti').stats().maxConcurrent, 2);
  assert.equal(llmGate('cavoti').stats().perMinute, 30);
  assert.equal(llmGate('glm53').stats().maxConcurrent, null, 'unlisted providers are not capped');

  applyQueueLimits({ maxPi: null, providers: {} }, { defaultMaxPi: 3 });
  assert.equal(piGate.stats().maxConcurrent, 3, 'no admin value: back to the environment default');
  assert.equal(llmGate('cavoti').stats().maxConcurrent, null);
  assert.equal(llmGate('cavoti').stats().perMinute, null);
});

test('raising the cap at runtime lets waiters in at once; lowering it never touches work that is running', async () => {
  applyQueueLimits({ maxPi: 1, providers: {} }, { defaultMaxPi: 3 });
  const first = await piGate.acquire();
  let started = 0;
  const waiters = [piGate.acquire().then(() => { started += 1; }), piGate.acquire().then(() => { started += 1; })];
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, 0);
  applyQueueLimits({ maxPi: 5, providers: {} }, { defaultMaxPi: 3 });
  await Promise.all(waiters);
  assert.equal(started, 2);
  applyQueueLimits({ maxPi: 1, providers: {} }, { defaultMaxPi: 3 });
  assert.equal(piGate.stats().active, 3, 'three still running under a cap of one - none was stopped');
  first();
});

test('the report lists every known provider with its limits and its live line', async () => {
  applyQueueLimits({ maxPi: null, providers: { cavoti: { maxConcurrent: 1, perMinute: null } } }, { defaultMaxPi: 3 });
  const release = await llmGate('cavoti').acquire();
  const waiting = llmGate('cavoti').acquire();
  const report = queueReport({ maxPi: null, providers: {} }, { defaultMaxPi: 3 });
  assert.equal(report.defaults.maxPi, 3);
  assert.deepEqual(Object.keys(report.providers).sort(), ['cavoti', 'glm53']);
  assert.equal(report.providers.cavoti.live.queued, 1);
  assert.equal(report.providers.cavoti.live.active, 1);
  assert.equal(report.providers.cavoti.limits.maxConcurrent, 1);
  release();
  (await waiting)();
});
