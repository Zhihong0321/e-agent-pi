import fs from 'node:fs/promises';
const site = await fs.readFile(new URL('./clioart-site.png', import.meta.url));
const psi = await fs.readFile(new URL('./pagespeed-evidence.png', import.meta.url));
let html = await fs.readFile(new URL('./deck.html', import.meta.url),'utf8');
html=html.replaceAll('__SITE_IMAGE__','data:image/png;base64,'+site.toString('base64')).replaceAll('__PSI_IMAGE__','data:image/png;base64,'+psi.toString('base64'));
for(const name of ['handoff','owner','cells','malaysia']){
 const token='__'+name.toUpperCase()+'_IMAGE__';
 if(html.includes(token))html=html.replaceAll(token,'data:image/png;base64,'+(await fs.readFile(new URL('./assets/'+name+'.png',import.meta.url))).toString('base64'));
}
await fs.writeFile(new URL('./index.html', import.meta.url),html);
console.log('Built slide/index.html — self-contained, 15 slides.');
