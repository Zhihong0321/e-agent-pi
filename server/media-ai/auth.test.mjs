import test from "node:test";
import assert from "node:assert/strict";
import { createShareToken, shareTokenHash } from "./host.mjs";
import { shareTokenHash as hashToken } from "./auth.mjs";

test("Media Kit share tokens are opaque, stable hashes", () => {
  const token = createShareToken();
  assert.match(token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(shareTokenHash(token), hashToken(token));
  assert.equal(shareTokenHash(token), shareTokenHash(token));
  assert.notEqual(shareTokenHash(token), shareTokenHash(createShareToken()));
});
