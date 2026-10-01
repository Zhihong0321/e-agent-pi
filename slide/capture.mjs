import { chromium } from 'playwright';
import fs from 'node:fs/promises';
const browser = await chromium.launch({headless:true});
const page = await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1});
try {
 await page.goto('https://ee-html.up.railway.app/app/clioart-printing-sdn-bhd/',{waitUntil:'networkidle',timeout:60000});
 await page.screenshot({path:'slide/clioart-site.png'});
 console.log(JSON.stringify({title:await page.title(),url:page.url()}));
} finally {await browser.close();}
