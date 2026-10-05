import { readFile } from 'node:fs/promises';
import { hasApiAuth } from './auth.mjs';
import { companyHostContext } from '../document_inteligence/host.mjs';
import { withContext } from '../document_inteligence/core/db.mjs';
import { getCompanyProfile, updateCompanyProfile } from '../document_inteligence/core/company.mjs';
import { previewCompanyReset, resetCompany } from '../document_inteligence/core/reset.mjs';

export async function handleCompanyProfile(req, res, url, getContext = companyHostContext) {
  const route = url.pathname.slice('/company-profile'.length);
  const json = (status, body) => {
    res.writeHead(status, { 'Content-Type':'application/json', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff' });
    res.end(JSON.stringify(body));
  };
  if (!hasApiAuth(req)) {
    if (req.method === 'GET' && !route.startsWith('/api/')) {
      res.writeHead(302, { Location:'/admin', 'Cache-Control':'no-store' }); res.end();
    } else json(401, { error:'Unlock Settings to edit Company Profile.' });
    return;
  }
  try {
    if (route.startsWith('/api/')) {
      const ctx = getContext();
      const scoped = fn => withContext(ctx.db, { ...ctx, actor:'owner', agent:'company-profile-form' }, fn);
      if (route === '/api/profile' && req.method === 'GET') return json(200, await scoped(getCompanyProfile));
      if (req.method !== 'POST') return json(405, { error:'Method not allowed' });
      if (req.headers['sec-fetch-site'] === 'cross-site') return json(403, { error:'Open Company Profile in this app.' });
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(415, { error:'Send JSON' });
      let raw = '';
      for await (const chunk of req) {
        raw += chunk.toString();
        if (Buffer.byteLength(raw) > 128000) return json(413, { error:'Request too large' });
      }
      const body = JSON.parse(raw || '{}');
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error:'Invalid request' });
      if (route === '/api/profile') {
        if (!Number.isInteger(body.expected_revision)) return json(400, { error:'Reload the profile before saving' });
        return json(200, await scoped(tx => updateCompanyProfile(tx, { ...body, source:'user', source_ref:'manual form' })));
      }
      if (body.restore_defaults !== undefined && typeof body.restore_defaults !== 'boolean') return json(400, { error:'Invalid reset option' });
      if (route === '/api/reset-preview') return json(200, await previewCompanyReset(ctx.db, ctx.tenantId, body.restore_defaults === true));
      if (route === '/api/reset') return json(200, await resetCompany(ctx.db, ctx.tenantId, body));
      return json(404, { error:'Not found' });
    }
    if (req.method !== 'GET') return json(405, { error:'Method not allowed' });
    const files = { '':['index.html','text/html'], '/':['index.html','text/html'], '/app.js':['app.js','text/javascript'], '/style.css':['style.css','text/css'] };
    const file = files[route];
    if (!file) return json(404, { error:'Not found' });
    const data = await readFile(new URL(`./company-profile/${file[0]}`, import.meta.url));
    res.writeHead(200, { 'Content-Type':`${file[1]}; charset=utf-8`, 'Cache-Control':'no-store',
      'X-Content-Type-Options':'nosniff', 'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    res.end(data);
  } catch (error) {
    const status = error?.details?.code === 'conflict' ? 409 : error?.name === 'DiError' || error instanceof SyntaxError ? 400 : 503;
    json(status, { error: status === 503 ? 'Company setup is unavailable. Please try again after the server finishes starting.' : error.message });
  }
}
