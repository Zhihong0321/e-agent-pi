import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { sendEmail, validateEmailRequest, handleEmailRequest, EE_MAIL_DISPATCH_TOKEN } from "./ee-mail.mjs";

test("email host authorizes documents and orchestrator, while requiring confirmation", async () => {
  const req = { headers: { authorization: `Bearer ${EE_MAIL_DISPATCH_TOKEN}` } };
  for (const agent of ["di-documents", "orchestrator"]) {
    const result = await handleEmailRequest(req, { agent });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /confirm=true/);
  }
  for (const agent of ["website", "di-payments", "", undefined]) {
    assert.equal((await handleEmailRequest(req, { agent })).status, 401);
  }
  assert.equal((await handleEmailRequest({ headers: { authorization: "Bearer wrong-token" } }, { agent: "orchestrator" })).status, 401);
});

test("validateEmailRequest requires explicit confirmation and one body", () => {
  assert.throws(() => validateEmailRequest({ to: "a@example.com", subject: "Hi", text: "Hello" }), /confirm=true/);
  assert.throws(() => validateEmailRequest({ confirm: true, to: "staff@eternalgy.me", subject: "Hi", text: "Hello", html: "<p>Hello</p>" }), /exactly one/);
  assert.throws(() => validateEmailRequest({ confirm: true, to: "a@example.com", subject: "Hi", text: "Hello" }), /only sends transactional email/);
  assert.deepEqual(validateEmailRequest({ confirm: true, to: " staff@eternalgy.me ", subject: " Hi ", text: "Hello" }), {
    to: ["staff@eternalgy.me"],
    subject: "Hi",
    text: "Hello",
  });
});

test("sendEmail posts to the service root /send and omits sender", async () => {
  let request;
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    request = { method: req.method, url: req.url, body: JSON.parse(raw) };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ messageId: "msg-1", status: "queued" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const result = await sendEmail({ confirm: true, to: "staff@eternalgy.me", subject: "Hi", text: "Hello" }, { baseUrl: base });
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/send");
    assert.deepEqual(request.body, { to: ["staff@eternalgy.me"], subject: "Hi", text: "Hello" });
    assert.equal(request.body.from, undefined);
    assert.deepEqual(result.provider, { messageId: "msg-1", status: "queued" });
  } finally {
    server.close();
  }
});

test("sendEmail reports provider rejection without exposing headers", async () => {
  const fetchImpl = async (_url, options) => ({ ok: false, status: 401, json: async () => ({ error: "bad key" }), options });
  await assert.rejects(
    sendEmail({ confirm: true, to: "staff@eternalgy.me", subject: "Hi", text: "Hello" }, { fetchImpl, apiKey: "secret" }),
    /HTTP 401.*bad key/,
  );
});
