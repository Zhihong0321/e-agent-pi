// Reading uploaded documents: PDF, Word and Excel to compact text, and the attachment
// pipeline that hands it to an agent. Fixtures are generated here, byte by byte, so the
// tests need no binary files and exercise the real parsers.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";
import { test } from "node:test";
import { documentKind, excerpt, extractDocument, legacyOfficeHint } from "./documents.mjs";
import { htmlToText } from "./office.mjs";
import { extractPdf, renderPdfPages, tidyPdfText } from "./pdf.mjs";
import { materializeAttachments } from "./attachments.mjs";

const HAVE_POPPLER = !spawnSync("pdftotext", ["-v"]).error;
const HAVE_RENDERER = !spawnSync("pdftoppm", ["-v"]).error;

// ---------------------------------------------------------------- fixtures

/** A valid PDF: each page is text lines, or a single embedded picture with no text at all. */
function buildPdf(pages) {
  const objects = [];
  const add = (body) => objects.push(body) && objects.length;
  const font = 3;
  const kids = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (const page of pages) {
    const pageNo = objects.length + 1;
    const contentNo = pageNo + 1;
    let stream;
    let resources = `/Font << /F1 ${font} 0 R >>`;
    if (page.image) {
      stream = "q 300 0 0 300 100 400 cm /Im0 Do Q";
      resources += ` /XObject << /Im0 ${contentNo + 1} 0 R >>`;
    } else {
      const esc = (s) => s.replace(/[\\()]/g, "\\$&");
      stream = `BT /F1 12 Tf 72 720 Td 16 TL ${page.lines.map((l) => `(${esc(l)}) '`).join(" ")} ET`;
    }
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${contentNo} 0 R /Resources << ${resources} >> >>`);
    add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    if (page.image) add("<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\x80\nendstream");
    kids.push(`${pageNo} 0 R`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** A stored (uncompressed) zip, which is all a docx or xlsx needs to be for a reader. */
function buildZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content, "utf8");
    const nameBuf = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function buildDocx({ heading, paragraphs, table, link }) {
  const p = (text, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`;
  const cell = (t) => `<w:tc><w:p><w:r><w:t>${xml(t)}</w:t></w:r></w:p></w:tc>`;
  const body = [
    heading && p(heading, "Heading1"),
    ...paragraphs.map((t) => p(t)),
    link && `<w:p><w:hyperlink r:id="rIdLink"><w:r><w:t>${xml(link.text)}</w:t></w:r></w:hyperlink></w:p>`,
    table && `<w:tbl>${table.map((row) => `<w:tr>${row.map(cell).join("")}</w:tr>`).join("")}</w:tbl>`,
  ].filter(Boolean).join("");
  const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  return buildZip({
    "[Content_Types].xml": '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    "_rels/.rels": '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/_rels/document.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${link ? `<Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xml(link.url)}" TargetMode="External"/>` : ""}</Relationships>`,
    "word/styles.xml": `<?xml version="1.0"?><w:styles ${ns}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`,
    "word/document.xml": `<?xml version="1.0"?><w:document ${ns}><w:body>${body}</w:body></w:document>`,
  });
}

/** sheets: [{ name, rows }]; a Date cell becomes a date-formatted serial, a string a shared string. */
function buildXlsx(sheets) {
  const strings = [];
  const sst = (s) => {
    const i = strings.indexOf(s);
    return i >= 0 ? i : strings.push(s) - 1;
  };
  const col = (i) => String.fromCharCode(65 + i);
  const sheetXml = ({ rows }) =>
    `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows
      .map((row, r) => `<row r="${r + 1}">${row.map((v, c) => {
        const ref = `${col(c)}${r + 1}`;
        if (v === null || v === "") return "";
        if (v instanceof Date) return `<c r="${ref}" s="1"><v>${(v.getTime() - Date.UTC(1899, 11, 30)) / 86400000}</v></c>`;
        if (typeof v === "number") return `<c r="${ref}"><v>${v}</v></c>`;
        return `<c r="${ref}" t="s"><v>${sst(String(v))}</v></c>`;
      }).join("")}</row>`)
      .join("")}</sheetData></worksheet>`;
  const sheetFiles = Object.fromEntries(sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]));
  return buildZip({
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    "_rels/.rels": '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    "xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rIdSst" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rIdSty" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>',
    ...sheetFiles,
    "xl/sharedStrings.xml": `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t xml:space="preserve">${xml(s)}</t></si>`).join("")}</sst>`,
  });
}

async function tmp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "docs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const put = async (dir, name, data) => {
  const file = path.join(dir, name);
  await writeFile(file, data);
  return file;
};
const b64 = (buf) => `data:application/octet-stream;base64,${buf.toString("base64")}`;

// ---------------------------------------------------------------- pure helpers

test("file kinds come from the extension, with a clear message for older Office files", () => {
  assert.equal(documentKind("Report.PDF"), "pdf");
  assert.equal(documentKind("a.docx"), "docx");
  assert.equal(documentKind("a.xlsx"), "xlsx");
  assert.equal(documentKind("blob", "application/pdf"), "pdf");
  assert.equal(documentKind("a.txt"), null);
  assert.match(legacyOfficeHint("old.doc"), /Save it as Word \.docx/);
  assert.match(legacyOfficeHint("old.XLS"), /Excel \.xlsx/);
  assert.equal(legacyOfficeHint("a.docx"), "");
});

test("pdf text: padding collapsed, pages marked, indentation dropped", () => {
  const raw = "Item                                   Qty        Price\n      Widget                            2         9.90\n\n\n\n\nTotal\f  Second page text here\f";
  const { text, chars, pages } = tidyPdfText(raw);
  assert.equal(pages, 2);
  assert.match(text, /^\[Page 1\]\nItem {2}Qty {2}Price\nWidget {2}2 {2}9\.90\n\nTotal\n\n\[Page 2\]\nSecond page text here$/);
  assert.ok(text.length < raw.length / 1.5, "far shorter than the padded original");
  assert.deepEqual(chars.map((n) => n > 10), [true, true]);
});

test("excerpt cuts at a line break and reports what was left", () => {
  const text = Array.from({ length: 50 }, (_, i) => `row ${i}`).join("\n");
  const first = excerpt(text, 100);
  assert.equal(first.truncated, true);
  assert.ok(first.text.endsWith("row 13") || first.text.split("\n").every((l) => /^row \d+$/.test(l)), "no half rows");
  const rest = excerpt(text, 100_000, first.shown);
  assert.equal(rest.truncated, false);
  assert.equal(excerpt("short", 100).truncated, false);
});

test("html to text: headings, lists, tables, links, images, entities", () => {
  const text = htmlToText(
    '<h1>Title &amp; more</h1><p>Intro <a href="https://x.test/a?b=1&amp;c=2">link</a> and <a href="#top">anchor</a>.</p>' +
      "<ul><li>one</li><li>two<ol><li>deep</li></ol></li></ul><ol><li>first</li><li>second</li></ol>" +
      "<table><tr><th>Name</th><th>Qty</th></tr><tr><td>Bolt<br>M8</td><td><p>4</p></td></tr></table>" +
      '<p>After <img src="" alt=""> pic&nbsp;&#169;</p>',
  );
  assert.equal(
    text,
    [
      "# Title & more",
      "",
      "Intro link (https://x.test/a?b=1&c=2) and anchor.",
      "",
      "- one",
      "- two",
      "  1. deep",
      "1. first",
      "2. second",
      "Name | Qty",
      "Bolt M8 | 4",
      "",
      "After [image] pic ©",
    ].join("\n"),
  );
});

// ---------------------------------------------------------------- PDF

test("pdf: text pages, page ranges, and pages that are only pictures", { skip: !HAVE_POPPLER && "pdftotext not installed" }, async (t) => {
  const dir = await tmp(t);
  const text = await put(dir, "text.pdf", buildPdf([
    { lines: ["Quarterly report first page", "Revenue was 1,200"] },
    { lines: ["Second page has more details"] },
    { lines: ["Third page closes the report"] },
  ]));
  const all = await extractPdf(text);
  assert.equal(all.ok, true);
  assert.equal(all.pages, 3);
  assert.match(all.text, /\[Page 1\]\nQuarterly report first page\nRevenue was 1,200\n\n\[Page 2\]\nSecond page/);
  assert.deepEqual(all.imagePages, []);

  const one = await extractPdf(text, { first: 3, last: 3 });
  assert.equal(one.pages, 1);
  assert.match(one.text, /^\[Page 3\]\nThird page closes/);

  const mixed = await put(dir, "mixed.pdf", buildPdf([{ lines: ["This page has real selectable text"] }, { image: true }]));
  const m = await extractPdf(mixed);
  assert.equal(m.ok, true, "a partly scanned document is still readable");
  assert.deepEqual(m.imagePages, [2]);

  const scan = await put(dir, "scan.pdf", buildPdf([{ image: true }, { image: true }]));
  const s = await extractPdf(scan);
  assert.equal(s.ok, false);
  assert.equal(s.scanned, true);
  assert.equal(s.text, "", "never the raw byte soup a scan contains");
  assert.equal(s.pages, 2);
  assert.match(s.error, /scanned or image-only/);
});

test("pdf page rendering finds the files pdftoppm wrote, whatever the zero padding", async (t) => {
  const dir = await tmp(t);
  const calls = [];
  const fake = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const prefix = args[args.length - 1];
    for (const n of ["02", "01", "10"]) await writeFile(`${prefix}-${n}.png`, "png");
    await writeFile(path.join(dir, "unrelated-p-1.png"), "png");
    return { ok: true, stdout: "", stderr: "" };
  };
  const result = await renderPdfPages(path.join(dir, "scan.pdf"), dir, { first: 1, last: 10 }, fake);
  assert.equal(result.ok, true);
  assert.deepEqual(result.files.map((f) => f.page), [1, 2, 10]);
  assert.deepEqual(calls[0].slice(0, 9), ["pdftoppm", "-png", "-r", "110", "-f", "1", "-l", "10", path.join(dir, "scan.pdf")]);

  const broken = await renderPdfPages("x.pdf", dir, {}, async () => ({ ok: false, stdout: "", stderr: "spawn pdftoppm ENOENT" }));
  assert.equal(broken.ok, false);
  assert.match(broken.error, /Could not render pages/);
});

// ---------------------------------------------------------------- Word and Excel

test("docx: headings, paragraphs, tables and links come out as readable text", async (t) => {
  const dir = await tmp(t);
  const file = await put(dir, "brief.docx", buildDocx({
    heading: "Site survey",
    paragraphs: ["Roof faces south & has no shading.", "Inverter room is dry."],
    link: { text: "datasheet", url: "https://example.com/spec" },
    table: [["Panel", "Qty"], ["550W", "16"]],
  }));
  const r = await extractDocument(file);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.kind, "docx");
  assert.equal(r.text, "# Site survey\n\nRoof faces south & has no shading.\n\nInverter room is dry.\n\ndatasheet (https://example.com/spec)\n\nPanel | Qty\n550W | 16");
});

test("xlsx: every sheet as compact CSV with dates, numbers and quoting", async (t) => {
  const dir = await tmp(t);
  const file = await put(dir, "sales.xlsx", buildXlsx([
    { name: "Sales", rows: [["Date", "Customer", "Amount", "Note"], [new Date(Date.UTC(2026, 8, 30)), 'Lim, "Wei"', 1200.5, ""], [new Date(Date.UTC(2026, 9, 1)), "Acme", 0.1 + 0.2, "ok"], [], [""]] },
    { name: "Empty", rows: [] },
  ]));
  const r = await extractDocument(file);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.sheets, ["Sales", "Empty"]);
  assert.equal(r.text, ['## Sales: 3 rows × 4 columns', "Date,Customer,Amount,Note", '2026-09-30,"Lim, ""Wei""",1200.5', "2026-10-01,Acme,0.3,ok", "", "## Empty", "(empty)"].join("\n"));
});

test("corrupt or wrong-format Office files fail with a message a person can act on", async (t) => {
  const dir = await tmp(t);
  const bad = await put(dir, "broken.docx", "this is not a zip archive");
  const d = await extractDocument(bad);
  assert.equal(d.ok, false);
  assert.match(d.error, /Could not read this \.docx file/);
  const x = await extractDocument(await put(dir, "broken.xlsx", "not a workbook"));
  assert.equal(x.ok, false);
  assert.match(x.error, /Could not read this \.xlsx file/);
  const legacy = await extractDocument(await put(dir, "old.xls", "x"));
  assert.equal(legacy.ok, false);
  assert.match(legacy.error, /Older Office files/);
});

// ---------------------------------------------------------------- attachment pipeline

test("attachments: documents are read, big ones keep the full text in a file and inline only an excerpt", async (t) => {
  const workspace = await tmp(t);
  const rows = Array.from({ length: 900 }, (_, i) => [`Customer ${i}`, i * 3.5, "paid"]);
  const attach = [
    { name: "Notes.docx", data: b64(buildDocx({ heading: "Handover", paragraphs: ["Keys are with security."] })) },
    { name: "ledger.xlsx", data: b64(buildXlsx([{ name: "Ledger", rows: [["Customer", "Amount", "Status"], ...rows] }])) },
  ];
  const { prompt, files, images } = await materializeAttachments(workspace, attach);
  assert.equal(files.length, 2);
  assert.equal(images.length, 0);
  assert.match(prompt, /- Word: _inbox\/\d+-1-Notes\.docx/);
  assert.match(prompt, /# Handover\n\nKeys are with security\./, "short files are inlined whole");
  assert.match(prompt, /- Excel: _inbox\/\d+-2-ledger\.xlsx/);
  assert.match(prompt, /Showing \d+ of \d+ chars\. Read the rest from _inbox\/\d+-2-ledger\.xlsx\.txt/);
  assert.ok(prompt.length < 17000, `prompt stays small (${prompt.length})`);
  assert.ok(!prompt.includes("Customer 899"), "the tail is not pasted into the prompt");

  const txt = await readFile(path.join(workspace, files[1].rel + ".txt"), "utf8");
  assert.match(txt, /Customer 899,3146\.5,paid$/, "the .txt holds everything");
});

test("attachments: a scanned PDF is reported honestly, never as garbage text", { skip: !HAVE_POPPLER && "pdftotext not installed" }, async (t) => {
  const workspace = await tmp(t);
  const { prompt, images, files } = await materializeAttachments(workspace, [{ name: "scan.pdf", data: b64(buildPdf([{ image: true }, { image: true }])) }]);
  assert.match(prompt, /Scanned PDF with no selectable text \(2 pages\)/);
  assert.ok(!/MuPDF|�|ÿÿÿ/.test(prompt));
  await assert.rejects(readFile(path.join(workspace, files[0].rel + ".txt")), "no text file for a scan");
  if (HAVE_RENDERER) {
    assert.equal(images.length, 2, "pages are attached as images for the model to read");
    assert.match(prompt, /attached as images/);
  } else {
    assert.equal(images.length, 0);
    assert.match(prompt, /could not be rendered/);
  }
});

test("attachments: pdf text is inlined once, with its page count", { skip: !HAVE_POPPLER && "pdftotext not installed" }, async (t) => {
  const workspace = await tmp(t);
  const { prompt } = await materializeAttachments(workspace, [{ name: "q3.pdf", data: b64(buildPdf([{ lines: ["Q3 revenue grew twelve percent"] }, { lines: ["Costs were flat over the period"] }])) }]);
  assert.match(prompt, /- PDF: _inbox\/\d+-1-q3\.pdf/);
  assert.match(prompt, /q3\.pdf\.txt \(2 pages, \d+ chars, pdftotext\)/);
  assert.match(prompt, /\[Page 2\]\nCosts were flat/);
});

test("attachments: unsupported and older formats are refused with advice", async (t) => {
  const workspace = await tmp(t);
  const one = (name) => materializeAttachments(workspace, [{ name, data: b64(Buffer.from("x")) }]);
  await assert.rejects(one("old.doc"), /Save it as Word \.docx/);
  await assert.rejects(one("old.xls"), /Save it as Excel \.xlsx/);
  await assert.rejects(one("notes.txt"), /Use an image, PDF, Word \(\.docx\) or Excel \(\.xlsx\) file/);
  await assert.rejects(materializeAttachments(workspace, Array.from({ length: 7 }, () => ({ name: "a.pdf", data: "eA==" }))), /at most 6/);
});
