import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Load the actual TypeScript helpers in Node; markdown rendering is irrelevant
// to the stream parser and its asset regex is the only import in this module.
const source = (await readFile(new URL('./studio.ts', import.meta.url), 'utf8'))
  .replace('import { IMAGE_EXT_RE } from "./chat-markdown";', 'const IMAGE_EXT_RE = /\\.(png|jpg)$/i;');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { readSse } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

test('null and non-event SSE payloads do not interrupt a valid reply', async () => {
  const response = new Response('data: null\n\ndata: []\n\ndata: {"other":true}\n\n: ping\n\ndata: {"type":"text","delta":"Hello"}\n\ndata: {"type":"done","reply":"Hello"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  const events = [];
  await readSse(response, event => events.push(event));
  assert.deepEqual(events, [{ type: 'text', delta: 'Hello' }, { type: 'done', reply: 'Hello' }]);
});
