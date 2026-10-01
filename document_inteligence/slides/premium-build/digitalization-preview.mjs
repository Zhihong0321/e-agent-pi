import fs from 'node:fs/promises';
import sharp from 'sharp';
const root='E:/000/UIv2/document_inteligence';
const source=`${root}/slides/premium-build/render`;
const output=`${root}/slides/premium-output`;
const layers=[];
for(let i=0;i<4;i++){
 const input=`${source}/slide-${String(i+6).padStart(2,'0')}.png`;
 layers.push({input:await sharp(input).resize(960,540).png().toBuffer(),left:24+(i%2)*984,top:24+Math.floor(i/2)*564});
}
await sharp({create:{width:1992,height:1152,channels:3,background:'#E2E8E2'}}).composite(layers).png().toFile(`${output}/digitalization-preview.png`);
await fs.copyFile(`${source}/slide-08.png`,`${output}/invoice-relational-data.png`);
const qa=[];
for(let i=0;i<22;i++){
 const file=`${source}/slide-${String(i+1).padStart(2,'0')}.png`;
 qa.push({input:await sharp(file).resize(384,216).png().toBuffer(),left:16+(i%4)*400,top:16+Math.floor(i/4)*232});
}
await sharp({create:{width:1616,height:1408,channels:3,background:'#E2E8E2'}}).composite(qa).png().toFile(`${root}/slides/premium-build/digitalization-contact-sheet.png`);
console.log('Digitalization previews saved');
