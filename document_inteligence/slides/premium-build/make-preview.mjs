import fs from 'node:fs/promises';
import sharp from 'sharp';
const root='E:/000/UIv2/document_inteligence';
const source=`${root}/slides/premium-build/render`;
const output=`${root}/slides/premium-output`;
const selected=[1,3,7,13];
const layers=[];
for(let i=0;i<selected.length;i++){
 const input=`${source}/slide-${String(selected[i]).padStart(2,'0')}.png`;
 layers.push({input:await sharp(input).resize(960,540).png().toBuffer(),left:24+(i%2)*984,top:24+Math.floor(i/2)*564});
}
await sharp({create:{width:1992,height:1152,channels:3,background:'#E2E8E2'}}).composite(layers).png().toFile(`${output}/business-premium-preview.png`);
for(const [i,name] of [[1,'cover'],[3,'three-barriers'],[7,'invoice-system'],[13,'cellular-ai']]) await fs.copyFile(`${source}/slide-${String(i).padStart(2,'0')}.png`,`${output}/${name}.png`);
console.log('Preview saved');
