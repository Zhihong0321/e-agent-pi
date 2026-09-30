import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { sendEmail, validateEmailRequest } from "./ee-mail.mjs";

test("validateEmailRequest requires explicit confirmation and one body", () => {
  assert.throws(() => validateEmailRequest({ to: "a@example.com", subject: "Hi", text: "Hello" }), /confirm=true/);
  assert.throws(() => validateEmailRequest({ confirm: true, to: "a@example.com", subject: "Hi", text: "Hello", html: "<p>Hello</p>" }), /exactly one/);
  assert.deepEqual(validateEmailRequest({ confirm: true, to: " a@example.com ", subject: " Hi ", text: "Hello" }), {
    to: ["a@example.com"],
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
    const result = await sendEmail({ confirm: true, to: "a@example.com", subject: "Hi", text: "Hello" }, { baseUrl: base });
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/send");
    assert.deepEqual(request.body, { to: ["a@example.com"], subject: "Hi", text: "Hello" });
    assert.equal(request.body.from, undefined);
    assert.deepEqual(result.provider, { messageId: "msg-1", status: "queued" });
  } finally {
    server.close();
  }
});

test("sendEmail reports provider rejection without exposing headers", async () => {
  const fetchImpl = async (_url, options) => ({ ok: false, status: 401, json: async () => ({ error: "bad key" }), options });
  await assert.rejects(
    sendEmail({ confirm: true, to: "a@example.com", subject: "Hi", text: "Hello" }, { fetchImpl, apiKey: "secret" }),
    /HTTP 401.*bad key/,
  );
});
