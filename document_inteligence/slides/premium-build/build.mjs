import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {Presentation,PresentationFile,FileBlob} from '@oai/artifact-tool';
import {GlobalFonts} from '@napi-rs/canvas';
import sharp from 'sharp';
const root='E:/000/UIv2/document_inteligence';
const build=path.join(root,'slides/premium-build');
const out=path.join(root,'slides/premium-output');
const skill='C:/Users/Eternalgy/.codex/plugins/cache/openai-primary-runtime/presentations/26.905.11957/skills/presentations';
const python='C:/Users/Eternalgy/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
GlobalFonts.registerFromPath('C:/Windows/Fonts/msyh.ttc','Microsoft YaHei');
GlobalFonts.registerFromPath('C:/Windows/Fonts/msyhbd.ttc','Microsoft YaHei');
const F='Microsoft YaHei';
const C={paper:'#F8F9F6',white:'#FFFFFF',ink:'#143D33',green:'#18775D',muted:'#65756E',line:'#CED9D1',mint:'#C6E4D7',pale:'#EAF2EB',gold:'#AA8A54'};
const p=Presentation.create({slideSize:{width:1280,height:720}});
const src={agents:'core/tools.mjs:16-24,729-737; host.mjs:26-70',docs:'core/documents.mjs:210-339,353-392,467-493,504-549,568-602; core/actions.mjs:31-114',forms:'core/forms.mjs:418-481,552-574,830-884,991-1060,1084-1178',setup:'ONBOARDING.md; README.md',dashboard:'core/dashboard.mjs:23-128; preview/crm-desktop.png',limits:'checker/index.mjs:48-50; ONBOARDING.md; README.md'};
function text(s,value,x,y,w,h,size=28,{color=C.ink,bold=false,align='left',middle=false}={}){
 const t=s.shapes.add({geometry:'textbox',position:{left:x,top:y,width:w,height:h},fill:'none',line:{fill:'none',width:0}});
 t.text=value;t.text.style={typeface:F,fontSize:size,color,bold,autoFit:'none',alignment:align,verticalAlignment:middle?'middle':'top'};return t;
}
function rule(s,x,y,w,color=C.line,width=1){return s.shapes.add({geometry:'line',position:{left:x,top:y,width:w,height:0},fill:'none',line:{fill:color,width}});}
function line(s,x1,y1,x2,y2,color=C.line,width=2){return s.shapes.add({geometry:'line',position:{left:Math.min(x1,x2),top:Math.min(y1,y2),width:Math.abs(x2-x1),height:Math.abs(y2-y1),verticalFlip:(x2-x1)*(y2-y1)<0},fill:'none',line:{fill:color,width}});}
function shape(s,geometry,x,y,w,h,{fill='none',stroke=C.line,width=1.5}={}){return s.shapes.add({geometry,position:{left:x,top:y,width:w,height:h},fill,line:{fill:stroke,width}});}
function node(s,value,x,y,w,h,{geometry='rect',fill=C.white,color=C.ink,size=27,stroke=C.line}={}){const a=shape(s,geometry,x,y,w,h,{fill,stroke});text(s,value,x+10,y+8,w-20,h-16,size,{color,bold:true,align:'center',middle:true});return a;}
function arrow(s,a,b,from='right',to='left'){return s.shapes.connect(a,b,{kind:'straight',fromSide:from,toSide:to,line:{fill:C.green,width:2},tail:{type:'arrow',width:'sm',length:'sm'}});}
function base(title,note,source,{footer=true}={}){
 const s=p.slides.add();s.background.fill=C.paper;
 if(title)text(s,title,72,58,1136,102,47,{bold:true});
 if(footer){text(s,'e by eternalgy',76,672,300,25,16,{color:C.muted});text(s,String(p.slides.items.length).padStart(2,'0'),1170,669,42,28,17,{color:C.muted,align:'right'});}
 s.speakerNotes.textFrame.setText(`${note}\n\n资料依据：${source||'创始人于本次对话提供的六个核心理念与定位。'}\n日期：2026-10-01。生成图为抽象示意，不作为事实证据。`);return s;
}
async function image(s,file,x,y,w,h,alt='Product evidence or conceptual artwork'){
 const blob=typeof file==='string'?new Uint8Array(await fs.readFile(path.join(root,file))):new Uint8Array(file);
 return s.images.add({blob,contentType:'image/png',fit:'contain',position:{left:x,top:y,width:w,height:h},alt});
}
async function imageBase(title,file,note,source){const s=p.slides.add();s.background.fill=C.paper;await image(s,file,0,0,1280,720,'ImageGen abstract cellular metaphor');text(s,title,72,58,1136,102,47,{bold:true});text(s,String(p.slides.items.length).padStart(2,'0'),1170,669,42,28,17,{color:C.muted,align:'right'});s.speakerNotes.textFrame.setText(`${note}\n依据：${source}\n视觉由内置 ImageGen 生成，文字为原生可编辑。日期：2026-10-01。`);return s;}
function gear(s,label,x,y,d,{fill=C.mint}={}){
 const commands=[];
 for(let i=0;i<48;i++){const a=i/48*Math.PI*2-Math.PI/2,r=d*([0,1].includes(i%4)?.49:.405),q={x:d/2+Math.cos(a)*r,y:d/2+Math.sin(a)*r};commands.push(i?{lineTo:q}:{moveTo:q});}
 commands.push({close:{}});
 s.shapes.add({geometry:'custom',position:{left:x,top:y,width:d,height:d},fill,line:{fill:'none',width:0},customPaths:[{width:d,height:d,commands}]});
 shape(s,'ellipse',x+d*.17,y+d*.17,d*.66,d*.66,{fill:C.paper,stroke:'none',width:0});
 text(s,label,x+d*.04,y+d*.30,d*.92,d*.40,23,{bold:true,align:'center',middle:true});
}
const coverFile=path.join(root,'assets/presentation/premium/brand-sculpture.png');
const coverMeta=await sharp(coverFile).metadata();
const coverCrop=await sharp(coverFile).extract({left:Math.round(coverMeta.width*.54),top:0,width:coverMeta.width-Math.round(coverMeta.width*.54),height:coverMeta.height}).png().toBuffer();

// 01. Brand and proposition
let s=base('', 'e by Eternalgy 是为团队设计的 AI，当前以 Document Intelligence 切入。公司上下文与流程是产品定位。现有 host 仍为单一操作员与默认公司。',src.setup,{footer:false});
await image(s,'assets/branding/document-inteligence-e-logo.png',74,76,55,55,'Original e brand mark');
text(s,'e by eternalgy',147,84,490,60,31,{bold:true});
text(s,'为团队打造的 AI',72,277,732,115,66,{bold:true});
text(s,'让公司资料，成为 AI 的工作依据',76,414,685,72,31,{color:C.muted});
text(s,'Let it know, Let it Work.',76,520,690,65,35,{color:C.green,bold:true});
await image(s,coverCrop,832,78,376,558,'ImageGen brand sculpture: shared structured company information');
text(s,'Document Intelligence',76,658,690,40,20,{color:C.muted});

// 02. Team context
s=base('团队工作，需要共同的公司上下文','这是问题定义与设计方向。团队角色示意不表示当前 host 已具有多成员账号或团队权限。',src.setup+'; '+src.agents);
text(s,'每个成员带来任务\n公司提供共同依据',76,199,610,155,48,{bold:true});
text(s,'成员经验与旧文件中的信息，\n需要延续到下一次工作',76,440,550,110,30,{color:C.muted});
const teamNodes=[];
for(const [label,y] of [['销售任务',222],['行政任务',343],['财务任务',464]])teamNodes.push(node(s,label,694,y,180,76,{fill:C.paper,size:25}));
const company=node(s,'共同的\n公司上下文',960,312,230,180,{geometry:'can',fill:C.pale,size:30,stroke:C.green});
teamNodes.forEach(a=>arrow(s,a,company));
text(s,'产品方向：团队协作。多人账号与权限仍待完善。',76,616,1100,37,22,{color:C.muted});

// 03. Commercial thesis
s=base('AI 变现的最后一里路，是使用门槛','水坝是创始人的商业化比喻，不是行业研究结论。搭建、使用、稳定三道门槛是产品设计与试点验证重点。');
text(s,'模型能力像水源，真正的价值需要跨过三道门槛',76,168,1110,60,29,{color:C.muted});
const damFile=path.join(root,'assets/presentation/premium/three-barriers.png');
const damMeta=await sharp(damFile).metadata();
const damCrop=await sharp(damFile).extract({left:0,top:Math.round(damMeta.height*.23),width:damMeta.width,height:Math.round(damMeta.height*.54)}).png().toBuffer();
await image(s,damCrop,72,242,1136,350,'ImageGen three gates metaphor');
for(const [n,label,x] of [['01','搭建门槛',486],['02','使用门槛',710],['03','稳定门槛',914]]){
 text(s,n,x,603,62,38,22,{color:C.gold,bold:true});text(s,label,x+64,597,188,46,29,{bold:true});
}

// 04. Know and work
s=base('Let it know, Let it Work.','公司理解指明确保存并被任务调用的公司上下文，不是模型自动训练。',src.setup+'; '+src.docs);
text(s,'让 e 知道',76,207,490,70,43,{bold:true,color:C.green});
text(s,'公司是谁\n客户与商品是什么\n文件与规则怎样运作',76,325,520,220,33);
text(s,'让 e 工作',702,207,490,70,43,{bold:true,color:C.green});
text(s,'查记录，准备文件\n发现缺项，先询问\n保存成果，延续后续工作',702,325,506,220,33);
rule(s,640,204,0);line(s,639,215,639,556,C.line,1);
text(s,'公司资料与规则，决定每一次工作怎样完成',76,609,1110,50,30,{bold:true});

// 05. Company understanding + digitalization expertise = an onboarded document expert.
s=base('为公司入职一位数字文档专家','按用户提供的解释流程：Know your company，结合 e 的 Expertise in Data Digitalisation，为公司 onboard 一位 Digital Document Expert。这是 AI 专家定位，不是实际人员招聘。公司资料、旧 invoice/quotation 与可读官网内容提供上下文，抽取事实与配置仍需用户确认。通过预置 schema、自定义字段、规则与模板适应公司工作。',src.setup+'; core/company.mjs:21-27; core/admin.mjs:57-82; core/documents.mjs:127-136');
const onboardingSteps=[
 ['01','了解你的公司','Know your\ncompany','公司资料、旧文件\n业务规则与工作习惯'],
 ['02','结合数字化专业能力','Expertise in\nData Digitalisation','数据建模与关系设计\n文件、表单与业务流程'],
 ['03','为公司入职文档专家','Digital Document\nExpert','理解公司设定\n按公司规则处理工作']
];
for(let i=0;i<onboardingSteps.length;i++){
 const x=72+i*400,[number,heading,english,detail]=onboardingSteps[i];
 text(s,number,x,205,65,51,29,{color:C.gold});
 text(s,heading,x,282,336,62,33,{bold:true,color:C.green});
 text(s,english,x,360,336,85,28,{bold:true});
 rule(s,x,467,332,C.line,1);
 text(s,detail,x,499,336,105,27,{color:C.muted});
}
text(s,'+',422,365,42,73,45,{color:C.muted,bold:true,align:'center'});
text(s,'=',822,365,42,73,45,{color:C.green,bold:true,align:'center'});
text(s,'公司理解与数字化专业能力，共同构成 e 的入职基础',76,614,1130,45,30,{bold:true});

// 06. Shared business structures
s=base('天下武功，殊途同归','常见业务共享客户、商品、文件、采集与规则等结构。e 当前使用预置业务 schema，可按公司配置字段、模板和规则，不是自动创建任意数据库。',src.setup+'; '+src.agents);
text(s,'不同业务，\n共享许多相同的结构',76,224,608,155,48,{bold:true});
text(s,'Expert of Digitalization',76,395,608,57,32,{color:C.green,bold:true});
text(s,'以常用数据结构承接工作，\n再适应公司的设定',76,470,570,110,30,{color:C.muted});
const common=node(s,'业务记录',858,340,210,130,{geometry:'can',fill:C.pale,size:31,stroke:C.green});
const terms=[['客户',710,214],['产品',1100,214],['文件',710,506],['表单',1100,506]];
for(const [label,x,y] of terms){const a=node(s,label,x,y,108,75,{fill:C.paper,size:29});arrow(s,a,common,x>900?'left':'right',x>900?'right':'left');}

// Digitalization: retain founder's distinction between paperless delivery and computable records.
s=base('数字化：让 DATA 在计算世界里活起来','Expert of Digitalization 是创始人补充的定位。单次生成 PDF 并不自动建立关联业务记录。数字化的定义是将业务信息转为计算机可理解、可关联、可计算的数据。此页比较输出方式，不概括所有竞品。',src.docs+'; core/documents.mjs:67-78,353-392');
text(s,'Paperless',76,195,480,60,39,{bold:true,color:C.muted});
text(s,'纸张变成 PDF\n方便保存与传递',76,274,490,96,30,{color:C.muted});
text(s,'Computer-meaningful Data',656,198,552,60,31,{bold:true,color:C.green});
text(s,'客户、商品、金额、时间\n成为可关联、可计算的数据',656,274,552,96,30);
line(s,608,206,608,572,C.line,1);
node(s,'Invoice\nPDF',161,397,282,154,{geometry:'flowChartDocument',fill:C.paper,size:36,stroke:C.line});
node(s,'PostgreSQL\n关系数据',784,397,298,154,{geometry:'can',fill:C.pale,size:34,stroke:C.green});
text(s,'e 在交付文件的同时，将业务信息保存为结构化记录',76,610,1130,55,31,{bold:true});

// Relational invoice and computable business questions, without invented dashboard data.
s=base('一张 Invoice，成为可持续计算的数据','关系示意简化自现有 schema：di.document(customer_id,issue_date,total,custom)、di.document_line(document_id,product_id,quantity,discount_amount)、di.customer、di.product。人员归属可配置为 custom 字段，不是默认 sales-agent 外键。右侧为可扩展分析示例，不是已交付的报表。收入需公司定义确认口径；热门商品需选数量或金额；折扣比例需定义分母与汇总口径。',src.docs+'; core/documents.mjs:67-78,353-392; core/admin.mjs:57-82; core/dashboard.mjs:23-128');
text(s,'Relational schema',76,167,550,54,28,{color:C.green,bold:true});
text(s,'分析示例：依实际字段与公司计算口径',656,169,552,54,24,{color:C.muted});
function schemaBlock(s,label,fields,x,y,w,h,{fill=C.white}={}){
 const a=shape(s,'rect',x,y,w,h,{fill,stroke:C.line});
 text(s,label,x+12,y+12,w-24,41,25,{bold:true});
 rule(s,x+12,y+57,w-24);
 text(s,fields,x+12,y+68,w-24,h-77,22,{color:C.muted});return a;
}
const relationalCustomer=schemaBlock(s,'Customer','id\nname',72,265,202,138);
const relationalInvoice=schemaBlock(s,'Invoice','customer_id\nissue_date / total\n人员归属（配置）',346,243,255,181,{fill:C.pale});
const relationalProduct=schemaBlock(s,'Product','id\nname',72,471,202,138);
const relationalLines=schemaBlock(s,'Invoice Line','document_id\nproduct_id / quantity\ndiscount_amount',346,455,255,181,{fill:C.pale});
arrow(s,relationalCustomer,relationalInvoice);arrow(s,relationalProduct,relationalLines);arrow(s,relationalInvoice,relationalLines,'bottom','top');
const digitalQuestions=[['每位销售人员的收入','关联人员归属与收入确认口径'],['每月业绩','按月份汇总开票与收款'],['热门商品','按商品汇总数量或金额'],['每位销售人员的折扣比例','关联人员与折扣明细，按统一口径比较']];
for(let i=0;i<digitalQuestions.length;i++){
 const y=243+i*100,[label,detail]=digitalQuestions[i];
 text(s,label,656,y,552,49,29,{bold:true,color:C.green});
 text(s,detail,656,y+48,552,48,25,{color:C.muted});
}

// Equipped digitalization tools and the collection-to-computation workflow.
s=base('e 的数字化工作方式与工具','创始人将 e 定位为 Expert of Digitalization。PostgreSQL、schema 查询和自定义字段、公开 HTML 表单发布、文件存储与分享为 repo 可证实的能力。Cloud Storage 为用户指定的部署方向，当前 repo 通过宿主 filesRoot/workspace 与 publicUrl 存储和发布，不代表已整合某一云对象存储服务。订单表单、工作报告表单是可配置采集用途，不是完整订单或工单产品。',src.agents+'; core/admin.mjs:57-82; core/actions.mjs:31-114; core/forms.mjs:552-574; host.mjs:197-242');
text(s,'数字化专业知识，落实到每一步数据处理',76,168,1130,65,35,{bold:true});
const toolStages=[['采集','Publishable Site','HTML 表单\n订单、工作报告'],['建模','Schema\nReference','理解字段与关系\n按公司设定校验'],['记录','PostgreSQL','保存关联业务记录\n承接查询与计算'],['交付','Cloud Storage','文件保存与分享\n云存储依部署配置']];
for(let i=0;i<toolStages.length;i++){
 const x=72+i*300,[label,tool,detail]=toolStages[i];
 text(s,label,x,302,246,60,40,{bold:true,color:C.green});
 rule(s,x,383,232,C.green,2);
 text(s,tool,x,410,252,59,26,{bold:true});
 text(s,detail,x,493,252,113,26,{color:C.muted});
 if(i<3)line(s,x+251,335,x+284,335,C.line,2);
}
text(s,'表单发布、schema 与数据记录已有实现；云端文件存储取决于部署配置。',76,625,1130,37,21,{color:C.muted});

// 07. Invoice contrast
s=base('同一个开票请求，两种处理方式','单次文件输出与 e 的流程方式做概念对比，不将所有其他 AI 归为只会 PDF。五个齿轮代表预置 schema、数据库记录、文档生命周期、SOP 与模板。',src.docs+'; '+src.agents);
text(s,'“Create 1 invoice for Acme…”',76,163,1130,55,31,{color:C.green,bold:true});
text(s,'单次文件输出',79,238,370,48,30,{color:C.muted,bold:true});
await image(s,'preview/invoice_due-p1.png',147,304,175,250,'Existing invoice PDF example');
text(s,'1 PDF Invoice',117,576,330,48,30,{color:C.muted,bold:true});
text(s,'VS',458,404,80,60,35,{color:C.muted,bold:true});
text(s,'e：文档是一条业务流程',624,238,584,48,31,{color:C.green,bold:true});
for(const [x1,y1,x2,y2] of [[741,360,889,437],[1037,360,889,437],[741,524,889,437],[1037,524,889,437]])line(s,x1,y1,x2,y2,C.line,3);
gear(s,'Schema\n数据结构',665,289,152);gear(s,'Workflow\n流程',961,289,152);
gear(s,'SOP\n工作规范',665,450,152);gear(s,'Template\n模板',961,450,152);gear(s,'DB\n业务记录',804,350,174,{fill:C.green});
text(s,'查记录、补缺项、发行文件、保存关联、追踪付款',620,622,588,44,23,{bold:true});

// 08. Lifecycle
s=base('文件与业务记录，延续到付款之后','准备不写记录，草稿可以修改，issue 时验证并编号，保存 snapshots，PDF 与付款记录进入持续流程。',src.docs);
const flow=[['01','准备','识别客户与商品\n检查缺项与规则'],['02','草稿','核对内容与金额\n确认后再发行'],['03','发行','编号与历史快照\nPDF 与业务关联'],['04','付款','记录分配与余额\n追踪应收状态']];
const flowNodes=[];
for(let i=0;i<flow.length;i++){const x=72+i*300,[n,t,b]=flow[i];text(s,n,x,222,65,55,29,{color:C.gold});const a=node(s,t,x,310,232,85,{fill:C.paper,size:37,stroke:C.green});flowNodes.push(a);text(s,b,x,442,242,130,29,{color:C.muted});}
for(let i=0;i<3;i++)arrow(s,flowNodes[i],flowNodes[i+1]);
text(s,'下一次工作，从已有记录继续',76,614,1110,49,32,{bold:true});

// 09. Forms
s=base('Form 收集信息，e 处理后续工作','表单、review、stats 与 CSV 是现有工具。工程报告、每日打卡是可配置的数据采集例子，不代表完整工单、考勤或薪资系统。',src.forms);
text(s,'工程报告 / 客户订单 / 问卷 / 每日打卡',76,172,1130,60,29,{color:C.muted});
const form=node(s,'Form\n收集与校验',72,302,224,174,{geometry:'flowChartDocument',size:30,stroke:C.green});
const db=node(s,'DB\n保存提交',376,302,224,174,{geometry:'can',fill:C.pale,size:30,stroke:C.green});
const ai=node(s,'专职 AI\n审阅与处理',680,302,224,174,{geometry:'ellipse',size:30,stroke:C.green});
const result=node(s,'工作成果\n记录 / 摘要 / CSV',984,302,224,174,{geometry:'flowChartDocument',size:25,stroke:C.green});
arrow(s,form,db);arrow(s,db,ai);arrow(s,ai,result);
text(s,'按字段绑定，关联客户、文件与下一步工作',76,587,1100,65,35,{bold:true});

// 10. Data visibility
s=base('业务记录，让工作状态可见','截图来自 CRM preview，金额与数量为演示数据。代码实现应收、逾期、开票与收款趋势、报价pipeline，截图不代表经营业绩。',src.dashboard);
text(s,'未收款项\n逾期 invoice\n待跟进 quotation',76,248,480,235,36,{bold:true});
text(s,'已有数据，形成业务概览',76,535,480,73,29,{color:C.muted});
const dashFile=path.join(root,'preview/crm-desktop.png');const dm=await sharp(dashFile).metadata();
const dashboard=await sharp(dashFile).extract({left:0,top:0,width:dm.width,height:Math.round(dm.width*.85)}).png().toBuffer();
await image(s,dashboard,583,181,625,424,'Existing CRM dashboard preview, illustrative data only');
text(s,'现有界面预览。图中金额与数量为演示数据。',587,624,620,35,21,{color:C.muted});

// 11. Specialist architecture
s=base('一个 Orchestrator，一组专职 AI','当前 registry 七个 DI specialist。Orchestrator 所在外围 UIv2 host 接收需求与派发任务，specialist 共享记录但工具各有授权范围。',src.agents+'; '+src.setup);
node(s,'Orchestrator\n需求分配与结果协调',438,187,404,91,{fill:C.pale,size:29,stroke:C.green});
line(s,640,278,640,327,C.green,2);line(s,148,327,1132,327,C.green,2);
const roles=['资料\n专员','文件\n专员','表单\n设计','表单\n审阅','公司\n入职','模板\n设计','数据库\n管理'];
for(let i=0;i<roles.length;i++){const x=72+i*164;line(s,x+76,327,x+76,364,C.green,2);text(s,roles[i],x,379,152,102,29,{bold:true,align:'center'});line(s,x+76,482,x+76,506,C.line,2);}
line(s,148,506,1132,506,C.line,2);line(s,640,506,640,536,C.line,2);
node(s,'共同的业务记录',449,538,382,72,{geometry:'can',fill:C.paper,size:29,stroke:C.green});

// 12. Cellular metaphor
s=await imageBase('Stupid = Smart：细胞级 AI','assets/presentation/cellular-human-imagegen.png','用细胞比喻说明分工与协作产生系统能力。修辞不对细胞认知能力作科学断言，也不等于仅靠单个 agent 就能保证整体可靠性。',src.agents);
text(s,'聪明的人，\n需要每个细胞都聪明吗？',72,190,740,151,49,{bold:true});
text(s,'“聪明的红血球？”\n“聪明的大肠细胞？”',76,394,680,120,34,{color:C.muted});
text(s,'整体的能力，来自分工与协作',76,603,690,65,35,{bold:true});

// 13. Cellular architecture
s=await imageBase('细胞级 AI 的协作方式','assets/presentation/cellular-ai-comparison-imagegen.png','两种架构思路的概念对比，不概括全部竞品。资料、模板、文件、表单为当前 specialist 职责例子。单元、调度与交接都需验证。',src.agents+'; '+src.docs);
text(s,'扩大一个 AI 的职责',112,154,490,55,31,{color:C.muted,bold:true});
text(s,'e：组合细胞级 AI',716,154,490,55,31,{color:C.green,bold:true});
text(s,'一个 AI\n包办所有工作',166,304,270,115,31,{bold:true,align:'center',middle:true});
text(s,'VS',583,345,80,65,36,{color:C.muted,bold:true});
for(const [label,x,y] of [['资料',739,226],['模板',1057,226],['文件',739,443],['表单',1057,443]])text(s,label,x,y,110,58,27,{bold:true,align:'center',middle:true});
text(s,'调度\n协作',866,319,160,98,31,{color:C.white,bold:true,align:'center',middle:true});
text(s,'职责越广，验证组合越多',104,611,495,48,26,{bold:true});
text(s,'明确任务、SOP、权限与测试',728,611,495,48,26,{color:C.green,bold:true});

// 14. Verifiable boundaries
s=base('可靠性，来自可检查的边界设计','可检查机制是代码事实，不等于已验证成功率、低错误率或零错误。RLS 隔离在 di_app 角色可用时生效，数据库角色 unavailable 时有降级限制。',src.docs+'; '+src.agents+'; '+src.limits);
const guards=[['任务范围','每位专员只使用获授权的工具','越权请求，由系统拒绝'],['发行规则','发行前检查必填信息与公司规则','资料未补齐，不能发行'],['记录约束','发行后冻结内容，并保存历史快照','后续修改，不改写旧文件']];
for(let i=0;i<guards.length;i++){const y=206+i*141;const [label,body,example]=guards[i];text(s,label,76,y,225,58,36,{bold:true,color:C.green});text(s,body,354,y,850,60,31,{bold:true});text(s,example,354,y+62,850,49,27,{color:C.muted});if(i<2)rule(s,76,y+118,1132);}
text(s,'单元测试、调度与集成验证，共同检验整体交付',76,630,1130,35,22,{color:C.muted});

// 15. Current state
s=base('Document Intelligence 是当前切入点','README 定义 MVP/working demo。当前 host 单操作员/default company，数据库 tenant-aware 不表示已有团队用户权限。MyInvois 尚无提交整合。',src.setup+'; '+src.limits);
text(s,'现有 MVP',76,212,520,65,39,{bold:true,color:C.green});
text(s,'客户与商品记录\nQuotation、invoice 与付款流程\n表单、模板与业务概览',76,328,540,220,31);
text(s,'产品方向',702,212,490,65,39,{bold:true,color:C.green});
text(s,'多人账号与团队权限\n更自动化的资料 onboarding\n更多可验证的业务流程与分析',702,328,506,220,31);
line(s,639,219,639,563,C.line,1);
text(s,'当前 host：单一操作员、默认公司。MyInvois 尚未整合提交。',76,619,1130,40,22,{color:C.muted});

// 16. Customer evaluation
s=base('客户试点，以一条真实流程开始','这是建议试点方法，不是正式套餐、价格、承诺期限或已取得客户成果。由客户选一条适合现有功能的流程，使用其真实资料并确认后运行。');
const pilot=[['01','选流程','开票，或表单采集与处理'],['02','用资料配置','旧文件、规则与客户记录'],['03','运行真实工作','确认输入，检查交付'],['04','对照指标验收','时间、返工与数据完整性']];
for(let i=0;i<pilot.length;i++){const y=204+i*109,[n,t,b]=pilot[i];text(s,n,76,y,94,61,33,{color:C.gold});text(s,t,217,y,362,61,37,{bold:true});text(s,b,674,y+4,534,58,29,{color:C.muted});if(i<3)rule(s,217,y+81,991);}

// 17. Investor evaluation
s=base('投资验证：门槛降低能否带来付费使用','投资命题是待验证的假设。没有 supplied traction、收入、市场规模、投资额、估值或财务数据，本页不虚构这些指标。');
text(s,'以重复文件工作切入，\n围绕公司上下文扩展',76,194,1120,147,49,{bold:true});
const questions=[['配置成本','能否更快进入实际工作？'],['任务可靠性','能否持续交付可检查的结果？'],['持续使用','是否成为重复工作的习惯？'],['付费意愿','价值是否足以支持商业化？']];
for(let i=0;i<questions.length;i++){const x=i%2?694:76,y=i<2?393:534;const [label,q]=questions[i];text(s,label,x,y,510,56,33,{color:C.green,bold:true});text(s,q,x,y+63,510,65,28,{color:C.muted});}

// 18. Decision
s=base('', '下一步：客户选一条真实流程试点，投资者共同验证商业化路径。不是报价、合同或募资条件。',null,{footer:false});
text(s,'e by eternalgy',76,80,780,70,35,{bold:true});
text(s,'Let it know,\nLet it Work.',72,233,1110,200,78,{bold:true,color:C.green});
text(s,'客户：带一条真实工作流程来试点\n投资者：共同验证团队 AI 的产品路径',76,554,1000,109,31);
await image(s,'assets/branding/document-inteligence-e-logo.png',1024,486,170,170,'Original e brand mark');

// 19. Sources
s=base('资料与产品边界','所有产品实现依据为本地 repo。生成图仅作视觉比喻，截图为演示数据。资料截至 2026-10-01。',Object.values(src).join('\n'));
const refs=[['产品定位','创始人提供的六个核心理念与团队 AI 方向'],['实现依据','README.md / ONBOARDING.md / host.mjs\ncore/tools.mjs / documents.mjs / forms.mjs / dashboard.mjs'],['证据边界','代码与预览支持功能说明，不代表部署验收或客户业绩\n可靠性、使用与商业指标，需要在真实试点中验证']];
for(let i=0;i<refs.length;i++){const [label,body]=refs[i],y=213+i*142;text(s,label,76,y,234,55,31,{color:C.green,bold:true});text(s,body,356,y,850,108,27);if(i<2)rule(s,76,y+116,1132);}
text(s,'资料日期：2026-10-01',76,636,1110,34,21,{color:C.muted});

await fs.mkdir(out,{recursive:true});await fs.mkdir(path.join(build,'render'),{recursive:true});
await fs.writeFile(path.join(build,'source.json'),JSON.stringify(p.toProto(),null,2));
const candidate=path.join(build,'candidate.pptx');await(await PresentationFile.exportPptx(p)).save(candidate);
console.log(`Candidate exported: ${p.slides.items.length} slides`);
const {finalizePresentation}=await import(pathToFileURL(path.join(skill,'container_tools/artifact_tool_utils.mjs')).href);
const final=path.join(out,'e-by-eternalgy-business-premium-onboarding.pptx');
const resultValidation=await finalizePresentation({workspaceDir:root,candidatePath:candidate,finalPath:final,pythonExecutable:python,integrityValidatorPath:path.join(skill,'container_tools/inspect_presentation_package_integrity.py'),layoutValidatorPath:path.join(skill,'container_tools/inspect_presentation_layout_geometry.py'),layoutArgs:['--expected-slide-size-emu','12192000,6858000','--validate-bullet-geometry','--validate-heading-fit'],requiredNativeTableOwnerSlides:[],requiredNativeChartOwnerSlides:[],fontPolicy:{basis:'design',families:[F]},verifyArtifactToolImport:true,receiptPath:path.join(build,'validation-onboarding.json')});
console.log(JSON.stringify({final:resultValidation.finalPath,layout:resultValidation.presentationLayout.findings,warnings:resultValidation.presentationLayout.warnings}));
const finalDeck=await PresentationFile.importPptx(await FileBlob.load(final));
for(let i=0;i<finalDeck.slides.items.length;i++){const blob=await finalDeck.export({slide:finalDeck.slides.items[i],format:'png',scale:1});await fs.writeFile(path.join(build,'render',`slide-${String(i+1).padStart(2,'0')}.png`),new Uint8Array(await blob.arrayBuffer()));console.log(`Rendered ${i+1}`);}
