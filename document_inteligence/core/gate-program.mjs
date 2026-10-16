// A gate written the way a person (or a model) writes Python: if / elif / else, proceed = True|False,
// reason = "...". The text is only READ here (tokenized and parsed by hand), never run: it is compiled into
// the ordered rule list gates.mjs stores and checks, where the first branch whose condition is true decides.
import { DiError } from "./common.mjs";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/;
const NUMBER = /^\d+(\.\d+)?/;
const OPERATOR = /^(==|!=|<=|>=|<|>)/;
const WORDS = { true: true, false: false, none: null };
const ALWAYS = { "==": [1, 1] };

function tokenize(src, line) {
  const out = []; let s = src.trim();
  while (s) {
    let m;
    if ((m = /^\s+/.exec(s))) { s = s.slice(m[0].length); continue; }
    if (s[0] === '"' || s[0] === "'") {
      const q = s[0]; let i = 1; let v = "";
      while (i < s.length && s[i] !== q) { if (s[i] === "\\" && i + 1 < s.length) i++; v += s[i++]; }
      if (i >= s.length) throw new DiError(`line ${line}: a quote is not closed`);
      out.push({ t: "str", v }); s = s.slice(i + 1);
    } else if ((m = NUMBER.exec(s))) { out.push({ t: "num", v: Number(m[0]) }); s = s.slice(m[0].length); }
    else if ((m = NAME.exec(s))) { out.push({ t: "name", v: m[0] }); s = s.slice(m[0].length); }
    else if ((m = OPERATOR.exec(s))) { out.push({ t: "op", v: m[0] }); s = s.slice(m[0].length); }
    else if ("()[],".includes(s[0])) { out.push({ t: s[0] }); s = s.slice(1); }
    else if (s[0] === "=") throw new DiError(`line ${line}: use == to compare (a single = assigns)`);
    else if ("+-*/%".includes(s[0])) throw new DiError(`line ${line}: calculations are not supported; compare a fact with a number`);
    else throw new DiError(`line ${line}: unexpected "${s[0]}"`);
  }
  return out;
}

// condition := or ; or := and ("or" and)* ; and := not ("and" not)* ; not := "not" not | comparison
// comparison := value (("==" | "!=" | "<" | "<=" | ">" | ">=" | "in" | "not in" | "is" | "is not") value)*
function parseCondition(src, line) {
  const toks = tokenize(src, line); let p = 0;
  const peek = (v) => toks[p] && (toks[p].t === "name" ? toks[p].v.toLowerCase() === v : toks[p].t === v);
  const fail = (what) => { throw new DiError(`line ${line}: ${what} in "${src.trim()}"`); };
  const value = () => {
    const k = toks[p++]; if (!k) fail("the condition ends too early");
    if (k.t === "num" || k.t === "str") return k.v;
    if (k.t === "name") return Object.hasOwn(WORDS, k.v.toLowerCase()) ? WORDS[k.v.toLowerCase()] : { var: k.v };
    if (k.t === "(") {
      const first = or();
      if (!peek(",")) { if (!peek(")")) fail("a bracket is not closed"); p++; return first; }
      const items = [first];
      while (peek(",")) { p++; if (!peek(")")) items.push(value()); }
      if (!peek(")")) fail("a bracket is not closed");
      p++; return items;
    }
    if (k.t === "[") {
      const items = [];
      while (!peek("]")) { if (!toks[p]) fail("a bracket is not closed"); items.push(value()); if (peek(",")) p++; else if (!peek("]")) fail("expected a comma or a closing bracket"); }
      p++; return items;
    }
    return fail(`unexpected "${k.t}"`);
  };
  const comparison = () => {
    let left = value(); const parts = [];
    for (;;) {
      let op = toks[p]?.t === "op" ? toks[p].v : null; let negate = false;
      if (op) p++;
      else if (peek("in")) { p++; op = "in"; }
      else if (peek("not") && toks[p + 1]?.v?.toLowerCase?.() === "in") { p += 2; op = "in"; negate = true; }
      else if (peek("is")) { p++; op = "=="; if (peek("not")) { p++; op = "!="; } }
      else break;
      const right = value(); const node = { [op]: [left, right] };
      parts.push(negate ? { "!": node } : node); left = right;
    }
    if (!parts.length) return left;
    return parts.length === 1 ? parts[0] : { and: parts };
  };
  const not = () => (peek("not") ? (p++, { "!": not() }) : comparison());
  const and = () => { const xs = [not()]; while (peek("and")) { p++; xs.push(not()); } return xs.length === 1 ? xs[0] : { and: xs }; };
  const or = () => { const xs = [and()]; while (peek("or")) { p++; xs.push(and()); } return xs.length === 1 ? xs[0] : { or: xs }; };
  const tree = or();
  if (p < toks.length) fail(`"${toks[p].v ?? toks[p].t}" does not belong here`);
  return tree !== null && typeof tree === "object" && !Array.isArray(tree) ? tree : { "==": [tree, true] };
}

function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    if (q) { if (line[i] === "\\") i++; else if (line[i] === q) q = null; } else if (line[i] === '"' || line[i] === "'") q = line[i]; else if (line[i] === "#") return line.slice(0, i);
  }
  return line;
}

/** The program as the ordered rule list (id line-N, when, then, message, src), or a DiError naming the line. */
export function compileProgram(text) {
  const branches = []; let last = null; let chain = false;
  String(text ?? "").replace(/\r/g, "").split("\n").forEach((raw, i) => {
    const line = i + 1; const body = stripComment(raw);
    if (!body.trim()) return;
    if (body.includes("\t")) throw new DiError(`line ${line}: indent with spaces, not tabs`);
    const indent = body.length - body.trimStart().length; const code = body.trim();
    if (indent === 0) {
      let m;
      if ((m = /^(if|elif)\s+(.+?)\s*:$/.exec(code))) {
        if (m[1] === "elif" && !chain) throw new DiError(`line ${line}: elif needs an if before it`);
        last = { line, src: m[2], when: parseCondition(m[2], line), set: {} }; chain = true;
      } else if (/^else\s*:$/.test(code)) {
        if (!chain) throw new DiError(`line ${line}: else needs an if before it`);
        last = { line, src: "else", when: ALWAYS, set: {} }; chain = false;
      } else if (/^(proceed|reason)\s*=/.test(code)) { last = { line, src: "True", when: ALWAYS, set: {} }; chain = false; assign(last, code, line); branches.push(last); last = null; return; }
      else throw new DiError(`line ${line}: write "if <condition>:", then indented lines "proceed = True or False" and "reason = \\"...\\"" (got: ${code.slice(0, 60)})`);
      branches.push(last); return;
    }
    if (!last) throw new DiError(`line ${line}: an indented line needs an if/elif/else above it`);
    if (/^(if|elif|else)\b/.test(code)) throw new DiError(`line ${line}: nested if is not supported; join the conditions with "and" in one if`);
    assign(last, code, line);
  });
  return branches.map((b) => {
    if (b.set.proceed === undefined) throw new DiError(`line ${b.line}: set proceed = True or proceed = False in this branch`);
    return { id: `line-${b.line}`, when: b.when, then: b.set.proceed ? "allow" : "block", message: b.set.reason ?? "", src: b.src };
  });
}

function assign(branch, code, line) {
  const m = /^(proceed|reason)\s*=\s*(.+)$/.exec(code);
  if (!m) throw new DiError(`line ${line}: only "proceed = True/False" and "reason = \\"text\\"" are allowed here (got: ${code.slice(0, 60)})`);
  const [tok] = tokenize(m[2], line);
  if (m[1] === "proceed") {
    const v = tok?.t === "name" ? WORDS[tok.v.toLowerCase()] : undefined;
    if (typeof v !== "boolean" || tokenize(m[2], line).length !== 1) throw new DiError(`line ${line}: proceed must be True or False`);
    branch.set.proceed = v;
  } else {
    if (tok?.t !== "str" || tokenize(m[2], line).length !== 1) throw new DiError(`line ${line}: reason must be one quoted sentence`);
    branch.set.reason = tok.v;
  }
}

/** The stored rules written back as a program, or null when some rule was not written as one. */
export function renderProgram(rules) {
  if (!rules.length || rules.some((r) => typeof r.src !== "string")) return null;
  return rules.map((r, i) => {
    const head = r.src === "else" ? "else:" : `${i === 0 || rules[i - 1].src === "else" ? "if" : "elif"} ${r.src}:`;
    return `${head}\n    proceed = ${r.then === "allow" ? "True" : "False"}${r.message ? `\n    reason = ${JSON.stringify(r.message)}` : ""}`;
  }).join("\n");
}
