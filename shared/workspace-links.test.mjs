import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workspaceFileUrl } from './workspace-links.mjs';

test('published URLs are independent of the viewing agent', () => {
  for (const url of ['/files/abc/invoice.pdf', 'https://example.com/files/abc/invoice.pdf', '/api/files/raw?agent=di-documents&path=documents%2Finvoice.pdf']) {
    assert.equal(workspaceFileUrl('orchestrator', url), url);
  }
});

test('old server paths retain their explicit owner and discard fake path queries', () => {
  const raw = 'file:///storage/workspaces/di-documents/documents/INV-2026-0001.pdf?agent=di-documents';
  const url = new URL(workspaceFileUrl('orchestrator', raw), 'https://example.com');
  assert.equal(url.searchParams.get('agent'), 'di-documents');
  assert.equal(url.searchParams.get('path'), 'documents/INV-2026-0001.pdf');
});
