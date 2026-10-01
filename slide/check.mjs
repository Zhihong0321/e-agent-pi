import {chromium} from 'playwright';
import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
await fs.mkdir('slide/qa',{recursive:true});
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1600,height:1058},deviceScaleFactor:1});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto(pathToFileURL(process.cwd()+'/slide/index.html').href);
await page.evaluate(()=>document.fonts.ready);
const results=[];
for(let i=0;i<15;i++){
 await page.evaluate(i=>show(i),i);
 results.push(await page.evaluate(()=>{const s=document.querySelector('.slide.active');const root=s.getBoundingClientRect();return{title:s.dataset.title,overflow:[...s.querySelectorAll('h1,h2,h3,p,table,img,.scoreline,.three,.rail,.quote')].filter(e=>!e.closest('.speaker')&&!(e.tagName==='IMG'&&e.parentElement.style.overflow==='hidden')).filter(e=>{const r=e.getBoundingClientRect();return r.right>root.right+1||r.bottom>root.bottom-(e.matches('img.full-bleed,img.owner-photo')?0:70)||r.left<root.left||r.top<root.top}).map(e=>({tag:e.tagName,text:e.textContent.slice(0,70)}))}}));
 if(!process.argv.includes('--quick')) await page.locator('#frame').screenshot({path:`slide/qa/${String(i+1).padStart(2,'0')}.png`});
}
await page.keyboard.press('Home');if(await page.locator('#counter').innerText()!=='01 / 15')throw Error('Home failed');
await page.keyboard.press('ArrowRight');if(await page.locator('#counter').innerText()!=='02 / 15')throw Error('Arrow failed');
await page.keyboard.press('n');if(!await page.locator('#notes').isVisible())throw Error('Notes failed');
await page.keyboard.press('Escape');if(await page.locator('#notes').isVisible())throw Error('Notes hide failed');
await page.keyboard.press('End');if(await page.locator('#counter').innerText()!=='15 / 15')throw Error('End failed');
await page.setViewportSize({width:390,height:844});
await page.waitForFunction(()=>document.querySelector('#frame').getBoundingClientRect().width<=innerWidth);
const mobile=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,frame:document.querySelector('#frame').getBoundingClientRect().toJSON()}));
await page.setViewportSize({width:1600,height:1058});
if(!process.argv.includes('--quick')) await page.pdf({path:'slide/Eternalgy-Agentic-AI.pdf',preferCSSPageSize:true,printBackground:true});
await fs.writeFile('slide/qa/check.json',JSON.stringify({errors,results,mobile},null,2));
console.log(JSON.stringify({errors,overflow:results.filter(r=>r.overflow.length),mobile},null,2));
await browser.close();
