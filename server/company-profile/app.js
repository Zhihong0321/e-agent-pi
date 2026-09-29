let profile;
let resetPreview;
const controls = new Map();
const changed = new Set();
const byId = id => document.getElementById(id);
function notice(message, error = false) { byId('notice').textContent = message; byId('notice').className = error ? 'error' : ''; }
async function api(path, body) {
  const response = await fetch(`/company-profile/api/${path}`, { cache:'no-store', credentials:'same-origin',
    ...(body ? { method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function render(data) {
  profile = data; changed.clear(); controls.clear(); byId('fields').replaceChildren();
  byId('readiness').textContent = data.readiness.minimum_ready ? 'Minimum setup complete' : 'Complete your minimum setup';
  byId('missing').textContent = data.readiness.minimum_ready ? 'Your agents can use these details. You can edit them below.' : `Still needed: ${data.readiness.missing.map(f=>f.label).join(', ')}.`;
  byId('invoice-status').textContent = data.readiness.invoice_profile_ready ? 'Invoice profile details are complete. Document and template checks still apply.' : `For invoicing: ${data.readiness.invoice_missing.map(f=>f.label).join(', ')}.`;
  const sections = new Map();
  for (const field of data.fields) {
    let grid = sections.get(field.section);
    if (!grid) {
      const group = document.createElement('fieldset'); const legend = document.createElement('legend'); legend.textContent=field.section;
      grid=document.createElement('div');grid.className='grid'; group.append(legend,grid); byId('fields').append(group); sections.set(field.section,grid);
    }
    const label=document.createElement('label'); const title=document.createElement('span');title.textContent=field.label+(field.required_for==='minimum'?' · minimum':'');label.append(title);
    const input=document.createElement(field.type==='select'?'select':['textarea','address'].includes(field.type)?'textarea':'input');
    input.id=`field-${field.key}`;input.name=field.key;
    if (field.type==='select') for(const value of ['',...field.options]) {const option=document.createElement('option');option.value=value;option.textContent=value?value.replaceAll('_',' '):'Choose…';input.append(option);}
    if (input.tagName==='INPUT') input.type = ['email','url','number'].includes(field.type)?field.type:'text';
    if(field.type==='number'){input.min='0';input.max='3650';input.step='1';}
    const value=data.company[field.key];
    input.value=field.type==='address' && typeof value==='object' ? ['line1','line2','line3','postcode','city','state','country'].map(k=>value?.[k]).filter(Boolean).join('\n') : value??'';
    input.addEventListener('input',()=>changed.add(field.key)); label.append(input);
    const help=document.createElement('small');help.textContent=field.help;label.append(help);
    const evidence=data.company.evidence?.[field.key];
    if(evidence && !evidence.confirmed){const hint=document.createElement('small');hint.className='evidence';hint.textContent=`Extracted from ${evidence.source} — review before confirming.`;label.append(hint);const confirm=document.createElement('button');confirm.type='button';confirm.textContent='Confirm this value';confirm.onclick=()=>{changed.add(field.key);hint.textContent='Will be confirmed when saved.';};label.append(confirm);}
    controls.set(field.key,{input,field});grid.append(label);
  }
  byId('save').disabled=false;
}
async function load(){try{render(await api('profile'));notice('');}catch(error){notice(error.message,true);}}
byId('profile').addEventListener('submit',async event=>{
  event.preventDefault();if(!profile)return;
  if(!changed.size)return notice('No changes to save.');
  const body={expected_revision:profile.company.revision};
  for(const key of changed){const {input,field}=controls.get(key);body[key]=field.type==='number'?(input.value===''?null:Number(input.value)):input.value;}
  byId('save').disabled=true;
  try{render(await api('profile',body));notice('Company profile saved. AI agents will read the updated details.');clearReset();}
  catch(error){notice(error.message,true);}finally{byId('save').disabled=false;}
});
byId('reload').onclick=()=>{if(!changed.size||window.confirm('Discard unsaved changes and reload?'))void load();};
function clearReset(){resetPreview=null;byId('reset-preview').hidden=true;byId('confirmation').value='';byId('confirm-reset').disabled=true;}
byId('restore-defaults').onchange=clearReset;
byId('preview-reset').onclick=async()=>{
  clearReset();
  try{
    resetPreview=await api('reset-preview',{restore_defaults:byId('restore-defaults').checked});
    byId('reset-company').textContent=`Reset ${resetPreview.company_name||'this company'}`;
    byId('reset-counts').replaceChildren();
    for(const [name,count] of Object.entries(resetPreview.counts)){const dt=document.createElement('dt');dt.textContent=name.replaceAll('_',' ');const dd=document.createElement('dd');dd.textContent=count;byId('reset-counts').append(dt,dd);}
    byId('reset-instruction').textContent=`Company profile values and numbering will also reset. Type exactly: ${resetPreview.confirmation}`;
    byId('reset-preview').hidden=false;
  }catch(error){notice(error.message,true);}
};
byId('confirmation').oninput=()=>{byId('confirm-reset').disabled=!resetPreview||byId('confirmation').value!==resetPreview.confirmation;};
byId('confirm-reset').onclick=async()=>{
  if(!resetPreview||byId('confirmation').value!==resetPreview.confirmation)return;
  byId('confirm-reset').disabled=true;
  try{const result=await api('reset',{fingerprint:resetPreview.fingerprint,confirmation:byId('confirmation').value,restore_defaults:resetPreview.restore_defaults});clearReset();await load();notice(`Reset complete. Recovery snapshot: ${result.backup_id}. Complete the new company profile above.`);}
  catch(error){clearReset();notice(error.message,true);}
};
void load();
