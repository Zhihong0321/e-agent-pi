// The one public page every form is rendered with. Agents never write HTML or scripts
// for a form: they write a field list, and this fixed, reviewed renderer turns it into a
// page. Every agent-written string is HTML-escaped; the only script is the one below,
// allowed by a per-response CSP nonce.

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ESC[ch]);
const para = (value) => esc(value).replace(/\r?\n/g, "<br>");

const CSS = `
:root{--bg:#f6f7f9;--card:#fff;--ink:#16181d;--muted:#5d6470;--line:#d9dde3;--accent:#2f5bd3;--bad:#b42318;--ok:#067647}
@media (prefers-color-scheme:dark){:root{--bg:#111318;--card:#1a1d24;--ink:#eceef2;--muted:#a3a9b5;--line:#2e333d;--accent:#7c9cff;--bad:#ff8a80;--ok:#6fd49a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:640px;margin:0 auto;padding:24px 16px 48px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px}
.company{color:var(--muted);font-size:14px;margin:0 0 4px}h1{font-size:24px;margin:0 0 8px}
.intro{color:var(--muted);margin:0 0 16px}.banner{background:#fff4d6;color:#6b4e00;border-radius:8px;padding:8px 12px;margin:0 0 16px;font-size:14px}
.field{margin:18px 0}.field>label,.field>.label{display:block;font-weight:600;margin:0 0 6px}
.req{color:var(--bad)}.help{color:var(--muted);font-size:14px;margin:4px 0 0}
input[type=text],input[type=email],input[type=tel],input[type=number],input[type=date],select,textarea{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink);font:inherit}
textarea{min-height:110px}.choice{display:flex;gap:8px;align-items:flex-start;margin:4px 0;font-weight:400}
.rating{display:flex;flex-wrap:wrap;gap:6px}.rating label{border:1px solid var(--line);border-radius:8px;padding:6px 12px;cursor:pointer}
.rating input{position:absolute;opacity:0}.rating input:checked+span{color:var(--accent);font-weight:700}
.section{margin:28px 0 8px;padding-top:12px;border-top:1px solid var(--line)}.section h2{font-size:18px;margin:0 0 4px}
.error{color:var(--bad);font-size:14px;margin:4px 0 0}.hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}
button{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:12px 20px;font:inherit;font-weight:600;cursor:pointer}
button[disabled]{opacity:.6;cursor:default}.done{color:var(--ok);font-weight:600}.small{color:var(--muted);font-size:13px;margin-top:16px}
`;

function fieldHtml(f) {
  const id = `f_${f.key}`;
  const req = f.required ? ' <span class="req" aria-hidden="true">*</span>' : "";
  const help = f.help ? `<p class="help">${para(f.help)}</p>` : "";
  const err = `<p class="error" data-error="${esc(f.key)}" role="alert"></p>`;
  const r = f.required ? " required" : "";
  const label = `<label for="${id}">${esc(f.label)}${req}</label>`;
  switch (f.type) {
    case "section":
      return `<div class="section"><h2>${esc(f.label)}</h2>${f.text ? `<p class="help">${para(f.text)}</p>` : ""}</div>`;
    case "textarea":
      return `<div class="field">${label}<textarea id="${id}" name="${esc(f.key)}" maxlength="${f.max_length}"${r}></textarea>${help}${err}</div>`;
    case "text":
    case "email":
    case "phone":
    case "number":
    case "date": {
      const type = { text: "text", email: "email", phone: "tel", number: "number", date: "date" }[f.type];
      const extra = [
        f.type === "text" ? ` maxlength="${f.max_length}"` : "",
        f.min !== undefined ? ` min="${esc(f.min)}"` : "",
        f.max !== undefined ? ` max="${esc(f.max)}"` : "",
        f.type === "number" ? ' step="any"' : "",
        f.type === "email" ? ' autocomplete="email"' : f.type === "phone" ? ' autocomplete="tel"' : "",
      ].join("");
      return `<div class="field">${label}<input id="${id}" type="${type}" name="${esc(f.key)}"${extra}${r}>${help}${err}</div>`;
    }
    case "select":
      return `<div class="field">${label}<select id="${id}" name="${esc(f.key)}"${r}><option value="">Choose…</option>${f.options
        .map((o) => `<option>${esc(o)}</option>`)
        .join("")}</select>${help}${err}</div>`;
    case "multiselect":
      return `<fieldset class="field" style="border:0;padding:0"><legend class="label">${esc(f.label)}${req}</legend>${f.options
        .map((o) => `<label class="choice"><input type="checkbox" name="${esc(f.key)}" value="${esc(o)}"> ${esc(o)}</label>`)
        .join("")}${help}${err}</fieldset>`;
    case "checkbox":
      return `<div class="field"><label class="choice"><input id="${id}" type="checkbox" name="${esc(f.key)}"${r}> <span>${esc(f.label)}${req}</span></label>${help}${err}</div>`;
    case "rating":
      return `<fieldset class="field" style="border:0;padding:0"><legend class="label">${esc(f.label)}${req}</legend><div class="rating">${Array.from(
        { length: f.scale },
        (_, i) => `<label><input type="radio" name="${esc(f.key)}" value="${i + 1}"${i === 0 ? r : ""}><span>${i + 1}</span></label>`,
      ).join("")}</div><p class="help">1 = lowest, ${f.scale} = highest</p>${help}${err}</fieldset>`;
    case "file": {
      const accept = [...(f.accept.includes("image") ? ["image/jpeg", "image/png", "image/webp", "image/gif"] : []), ...(f.accept.includes("pdf") ? ["application/pdf"] : [])];
      const note = `${f.accept.join(" or ")}, up to ${f.max_mb} MB${f.max_files > 1 ? ` each, max ${f.max_files} files` : ""}`;
      return `<div class="field">${label}<input id="${id}" type="file" name="${esc(f.key)}" accept="${accept.join(",")}" data-max-mb="${f.max_mb}" data-max-files="${f.max_files}"${f.max_files > 1 ? " multiple" : ""}${r}><p class="help">${esc(note)}</p>${help}${err}</div>`;
    }
    default:
      return "";
  }
}

const SCRIPT = `
(function(){
  var form=document.getElementById('diform'); if(!form) return;
  var spec=JSON.parse(document.getElementById('dispec').textContent);
  function showErrors(errors){
    document.querySelectorAll('[data-error]').forEach(function(p){p.textContent=errors[p.getAttribute('data-error')]||'';});
    var g=document.getElementById('general'); g.textContent=errors._form||errors._files||errors._consent||(Object.keys(errors).length?'Please check the highlighted answers.':'');
  }
  function readFile(file){return new Promise(function(ok,bad){var r=new FileReader();r.onload=function(){ok({name:file.name,base64:String(r.result).split(',')[1]||''});};r.onerror=bad;r.readAsDataURL(file);});}
  form.addEventListener('submit',async function(e){
    e.preventDefault();
    var btn=form.querySelector('button'); var data={}; var files={}; var errors={};
    for(const f of spec.fields){
      if(f.type==='section') continue;
      var els=form.querySelectorAll('[name="'+f.key+'"]');
      if(f.type==='file'){
        var list=Array.from(els[0].files||[]);
        if(list.length>f.max_files){errors[f.key]='At most '+f.max_files+' file(s).';continue;}
        if(list.some(function(x){return x.size>f.max_mb*1048576;})){errors[f.key]='Each file must be '+f.max_mb+' MB or smaller.';continue;}
        if(list.length) files[f.key]=await Promise.all(list.map(readFile));
      } else if(f.type==='checkbox'){ data[f.key]=els[0].checked; }
      else if(f.type==='multiselect'){ data[f.key]=Array.from(els).filter(function(x){return x.checked;}).map(function(x){return x.value;}); }
      else if(f.type==='rating'){ var c=Array.from(els).find(function(x){return x.checked;}); if(c) data[f.key]=Number(c.value); }
      else { data[f.key]=els[0].value; }
    }
    if(Object.keys(errors).length){showErrors(errors);return;}
    var consent=document.getElementById('consent');
    btn.disabled=true; btn.textContent='Sending…';
    try{
      var res=await fetch(form.getAttribute('action'),{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({data:data,files:files,consent:consent?consent.checked:undefined,_hp:form.querySelector('[name=_hp]').value})});
      var out=await res.json().catch(function(){return {};});
      if(res.ok&&out.ok){form.outerHTML='<p class="done" role="status"></p>';document.querySelector('.done').textContent=out.message||'Thank you.';return;}
      showErrors(out.errors||{_form:out.error||'Something went wrong. Please try again.'});
    }catch(err){showErrors({_form:'Could not send. Check your connection and try again.'});}
    btn.disabled=false; btn.textContent='Submit';
  });
})();`;

/**
 * @param {{ form: {slug: string, title: string}, version: {version: number, fields: any[], settings: any},
 *           company?: {name?: string, legal_name?: string}, preview?: boolean, action?: string, nonce?: string }} p
 */
export function renderFormPage({ form, version, company, preview = false, action, nonce = "" }) {
  const settings = version.settings || {};
  const fields = version.fields || [];
  const spec = { fields: fields.map(({ key, type, max_files, max_mb }) => ({ key, type, max_files, max_mb })) };
  const consent = settings.consent_text
    ? `<div class="field"><label class="choice"><input id="consent" type="checkbox" required> <span>${para(settings.consent_text)} <span class="req">*</span></span></label></div>`
    : "";
  const banner = preview ? `<p class="banner">Preview of version ${esc(version.version)} (${esc(version.status || "draft")}). Submitting is disabled here.</p>` : "";
  const who = company?.name || company?.legal_name;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(form.title)}</title><style>${CSS}</style></head>
<body><main><div class="card">
${banner}${who ? `<p class="company">${esc(who)}</p>` : ""}<h1>${esc(form.title)}</h1>
${settings.intro ? `<p class="intro">${para(settings.intro)}</p>` : ""}
<form id="diform" action="${esc(action || `/api/forms/${form.slug}`)}" method="post" novalidate>
${fields.map(fieldHtml).join("\n")}
<div class="hp" aria-hidden="true"><label>Leave this empty <input type="text" name="_hp" tabindex="-1" autocomplete="off"></label></div>
${consent}
<p class="error" id="general" role="alert"></p>
<button type="submit"${preview ? " disabled" : ""}>Submit</button>
</form>
<p class="small">Do not enter passwords, PINs or card details in this form.</p>
</div></main>
<script type="application/json" id="dispec">${JSON.stringify(spec).replace(/</g, "\\u003c")}</script>
${preview ? "" : `<script nonce="${esc(nonce)}">${SCRIPT}</script>`}
</body></html>`;
}

export function renderMessagePage(title, message, company) {
  const who = company?.name || company?.legal_name;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>${CSS}</style></head>
<body><main><div class="card">${who ? `<p class="company">${esc(who)}</p>` : ""}<h1>${esc(title)}</h1><p class="intro">${esc(message)}</p></div></main></body></html>`;
}
