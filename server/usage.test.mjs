import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeUsage, redactUsageMeta, ensureUsageSchema } from './usage.mjs';

test('normalizes common provider token shapes', () => {
  assert.deepEqual(normalizeUsage({ input_tokens: 12, output_tokens: 8 }), {
    inputTokens: 12, outputTokens: 8, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: 20, credits: null,
  });
  assert.deepEqual(normalizeUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 20, cacheRead: 2, credits: 3 }), {
    inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: null, totalTokens: 20, credits: 3,
  });
});

test('redacts secret-like metadata without retaining prompts', () => {
  const redacted = redactUsageMeta({ token: 'secret', apiKey: 'key', lane: 'G1' });
  assert.equal(redacted.token, '[REDACTED]');
  assert.equal(redacted.apiKey, '[REDACTED]');
  assert.equal(redacted.lane, 'G1');
});

test('usage schema creates the ledger and indexes', async () => {
  const calls = [];
  await ensureUsageSchema({ query: async sql => { calls.push(sql); } });
  assert.match(calls[0], /CREATE TABLE IF NOT EXISTS api_usage/);
  assert.match(calls[0], /input_tokens BIGINT/);
  assert.match(calls[0], /api_usage_occurred_idx/);
});

test('preserves explicit totals, inclusive cached input and unknown usage', () => {
  assert.equal(normalizeUsage({ input: 8, output: 2, total: 99 }).totalTokens, 99);
  assert.equal(normalizeUsage({ prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 6 } }).totalTokens, 15);
  assert.equal(normalizeUsage({ input: 10, output: 5, cacheRead: 6 }).totalTokens, 21);
  assert.equal(normalizeUsage({ input: null }).inputTokens, null);
});
