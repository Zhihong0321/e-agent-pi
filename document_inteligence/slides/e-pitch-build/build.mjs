import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {Presentation, PresentationFile, FileBlob} from '@oai/artifact-tool';
import {GlobalFonts} from '@napi-rs/canvas';
import sharp from 'sharp';

const root='E:/000/UIv2/document_inteligence';
const build=path.join(root,'slides/e-pitch-build');
const output=path.join(root,'slides/e-pitch-output');
const skill='C:/Users/Eternalgy/.codex/plugins/cache/openai-primary-runtime/presentations/26.905.11957/skills/presentations';
const python='C:/Users/Eternalgy/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
GlobalFonts.registerFromPath('C:/Windows/Fonts/msyh.ttc','Microsoft YaHei');
GlobalFonts.registerFromPath('C:/Windows/Fonts/msyhbd.ttc','Microsoft YaHei');
const font='Microsoft YaHei';
const {finalizePresentation}=await import(pathToFileURL(path.join(skill,'container_tools/artifact_tool_utils.mjs')).href);
const p=Presentation.create({slideSize:{width:1280,height:720}});
const C={dark:'#103C35',teal:'#167B63',mint:'#A4DCC7',white:'#FFFFFF',paper:'#F5F7F4',ink:'#173D35',muted:'#58716B',gray:'#D6E0DA'};
const sources={
  agents:'core/tools.mjs:16-24; host.mjs:26-70',
  docs:'core/documents.mjs:210-339,353-392,467-493,504-549,568-602; core/actions.mjs:31-114',
  forms:'core/forms.mjs:418-481,552-574,754-797,830-884,991-1060,1084-1178',
  dashboard:'core/dashboard.mjs:23-128; preview/crm-desktop.png',
  setup:'ONBOARDING.md; core/company.mjs; README.md',
  limits:'checker/index.mjs:48-50; ONBOARDING.md; README.md'
};
function txt(s,text,x,y,w,h,size=30,color=C.ink,bold=false){
 const o=s.shapes.add({geometry:'textbox',position:{left:x,top:y,width:w,height:h},fill:'none',line:{fill:'none',width:0}});
 o.text=text;o.text.style={typeface:font,fontSize:size,color,bold,autoFit:'none'};return o;
}
function slide(title,{dark=false,note='',source=''}={}){
 const s=p.slides.add();s.background.fill=dark?C.dark:C.paper;
 if(title)txt(s,title,72,58,1136,105,48,dark?C.white:C.ink,true);
 txt(s,String(p.slides.items.length).padStart(2,'0'),1170,662,48,30,16,dark?C.mint:C.muted);
 s.speakerNotes.textFrame.setText(`${note}\n\n依据：${source||'创始人于本次对话提供的产品理念。定位和愿景不代表已发布的全部能力。'}\n资料日期：2026-10-01。`);
 return s;
}
async function img(s,file,x,y,w,h,alt){s.images.add({blob:new Uint8Array(await fs.readFile(path.join(root,file))),contentType:'image/png',fit:'contain',position:{left:x,top:y,width:w,height:h},alt});}
async function imageSlide(title,file,note,source){
 const s=p.slides.add();s.background.fill=C.paper;
 await img(s,file,0,0,1280,720,'ImageGen abstract cellular AI visual metaphor');
 txt(s,title,72,58,1136,105,48,C.ink,true);
 txt(s,String(p.slides.items.length).padStart(2,'0'),1170,662,48,30,16,C.muted);
 s.speakerNotes.textFrame.setText(`${note}\n\n依据：${source}\n图像：内置 ImageGen 生成的抽象架构比喻，并非生物学结构或实物照片。标题与文字保持原生可编辑。\n资料日期：2026-10-01。`);
 return s;
}
function pair(s,left,right,{top=230}={}){
 txt(s,left.title,72,top,510,65,34,C.teal,true);txt(s,left.body,72,top+85,510,250,30,C.ink);
 txt(s,right.title,680,top,510,65,34,C.teal,true);txt(s,right.body,680,top+85,510,250,30,C.ink);
}
function node(s,label,x,y,w,h,{geometry='rect',fill=C.teal,color=C.white,size=27}={}){
 const sh=s.shapes.add({geometry,position:{left:x,top:y,width:w,height:h},fill,line:{fill:'none',width:0}});
 const t=txt(s,label,x+8,y+8,w-16,h-16,size,color,true);t.text.style={typeface:font,fontSize:size,color,bold:true,autoFit:'none',alignment:'center',verticalAlignment:'middle'};return sh;
}
function link(s,a,b,{from='right',to='left',color=C.teal}={}){
 return s.shapes.connect(a,b,{kind:'straight',fromSide:from,toSide:to,line:{fill:color,width:3},tail:{type:'arrow',width:'med',length:'med'}});
}
function gear(s,label,x,y,d,fill=C.teal){
 const commands=[];
 for(let i=0;i<48;i++){
  const a=(i/48)*Math.PI*2-Math.PI/2;
  const radius=d*([0,1].includes(i%4)?0.49:0.405);
  const point={x:d/2+Math.cos(a)*radius,y:d/2+Math.sin(a)*radius};
  commands.push(i?{lineTo:point}:{moveTo:point});
 }
 commands.push({close:{}});
 const g=s.shapes.add({geometry:'custom',position:{left:x,top:y,width:d,height:d},fill,line:{fill:'none',width:0},customPaths:[{width:d,height:d,commands}]});
 s.shapes.add({geometry:'ellipse',position:{left:x+d*.17,top:y+d*.17,width:d*.66,height:d*.66},fill:C.paper,line:{fill:'none',width:0}});
 const t=txt(s,label,x+d*.07,y+d*.30,d*.86,d*.40,23,C.ink,true);t.text.style={typeface:font,fontSize:23,color:C.ink,bold:true,autoFit:'none',alignment:'center',verticalAlignment:'middle'};return g;
}
let s=slide('',{dark:true,note:'开场：e by Eternalgy 是为团队打造的 AI。核心理念是把 AI 的工作能力与公司的资料、设定和工作流程绑定。本阶段产品以 Document Intelligence 为切入点。团队定位描述产品方向，当前 host 仍为单一操作员、默认公司。'});
txt(s,'e',72,90,270,220,190,C.white,true);
txt(s,'by eternalgy',82,305,510,70,42,C.mint);
txt(s,'为团队打造的 AI',72,445,790,85,54,C.white,true);
txt(s,'Let it know, Let it Work.',76,555,900,65,34,C.mint);
await img(s,'assets/branding/document-inteligence-e-logo.png',880,160,290,290,'Eternalgy e 原始品牌标志');

s=slide('团队工作，需要共同的公司上下文',{note:'痛点是公司信息常分散在旧文件、表单与不同成员手里。我们提出的产品命题是：每一次 AI 工作都应使用同一套经过确认的公司资料和规则。这是创始人的问题定义，不是对全部竞品的事实判断。'});
txt(s,'成员知道的事，\n应成为 e 工作的依据',72,200,1080,160,58,C.ink,true);
txt(s,'公司资料散落在旧文件与成员经验中\n重复解释背景，重复录入资料，交接依赖个人\n团队需要延续前一次工作的记录与规则',76,414,1080,190,31,C.muted);

s=slide('AI 变现的水坝原理',{dark:true,note:'创始人的水坝原理是商业化比喻，而非经外部研究证实的行业结论：大模型能力像水源，使用门槛像拦水的坝。最后一里路是让公司实际搭建、成员实际使用并持续可靠完成工作。三个门槛为搭建、使用和稳定。这里的水源并无具体 model 性能比较，避免未经核实的模型名称与前沿基准。'});
txt(s,'AI 能力像水源\n使用门槛像一道坝',72,190,1100,160,60,C.white,true);
txt(s,'搭建门槛       使用门槛       稳定门槛',76,411,1110,75,38,C.mint,true);
txt(s,'AI 变现的最后一里路：\n公司搭得起，成员用得上，工作交付值得信任',76,530,1110,120,32,C.white);

s=slide('e 围绕三道门槛设计',{note:'快速搭建是目标，依靠公司资料 onboarding、常用业务数据结构和流程知识，并仍需要用户确认。零使用门槛是创始人的设计目标，具体实现为聊天入口和内勤助理使用方式，并非已验证的零培训或无限制可用性。稳定门槛由 scope、SOP、工具权限、数据库约束和测试来降低，不代表 harness 已达到零错误。细胞/器官比喻解释可组合性，整体还需要 orchestration、交接与集成验证。',source:sources.setup+'; '+sources.agents+'; '+sources.docs});
txt(s,'搭建',72,205,175,70,39,C.teal,true);
txt(s,'分享公司资料，配置已有流程与业务结构',285,205,900,70,32,C.ink);
txt(s,'使用',72,330,175,70,39,C.teal,true);
txt(s,'聊天就是入口，像交代内部 admin clerk 一样交代工作',285,330,900,100,32,C.ink);
txt(s,'稳定',72,478,175,70,39,C.teal,true);
txt(s,'细胞级专职 AI 各守职责，以 SOP、权限与测试约束流程',285,478,900,110,32,C.ink);
txt(s,'设计目标：更快搭建、更少学习负担、更一致的交付',76,630,1110,40,24,C.muted);

s=slide('Let it know, Let it Work.',{dark:true,note:'让 e 知道：公司的身份、客户与商品、模板、付款条件和流程规则。让 e 工作：查找记录、询问缺项、完成文件、保存关联数据。这里的公司理解指明确保存并在任务中调用的业务上下文，不是模型自动训练。',source:sources.setup+'; '+sources.docs});
txt(s,'让 e 知道',72,215,520,80,48,C.mint,true);
txt(s,'公司是谁\n客户与商品是什么\n文件怎样做，流程怎样走',72,328,530,230,32,C.white);
txt(s,'让 e 工作',680,215,520,80,48,C.mint,true);
txt(s,'按公司资料准备文件\n发现缺项，先询问再处理\n把成果与业务记录连接起来',680,328,530,230,32,C.white);

s=slide('像新同事一样，先了解公司',{note:'保留创始人的拟人学习比喻。用已有 invoice、quotation、company profile 和官网内容作为背景材料，提取信息后请用户确认，写入公司资料并预览模板。当前没有在此 repo 新增独立 OCR 或爬虫服务。官网与文件的可读性取决于 host 工具，不能承诺只看几张文件就完全自动完成设置。',source:sources.setup});
txt(s,'旧文件与公司资料\n成为入职材料',72,200,640,135,50,C.ink,true);
txt(s,'Invoice / Quotation\nCompany Profile / 官网内容',76,366,610,110,30,C.teal,true);
txt(s,'读取资料，提取核心信息\n用户确认后保存公司设定\n预览模板，核对实际工作结果',76,500,655,132,28,C.muted);
await img(s,'preview/quotation-p1.png',845,178,338,458,'现有报价单预览，作为 onboarding 文件示例');

s=slide('天下武功，殊途同归',{note:'创始人的判断是：很多公司虽有不同的行业语言，常见业务底层仍涉及客户、商品、文件、数据采集和工作规则。e 当前预置常用业务 schema，可通过字段、模板和 readiness rules 做公司配置。这不是任意自动设计数据库或支持所有行业的承诺。',source:sources.agents+'; README.md'});
txt(s,'不同公司的工作，\n共享许多相同的业务结构',72,205,1110,150,54,C.ink,true);
txt(s,'客户与联系人      产品与服务      业务文件\n表单与提交记录    公司设定与流程规则',76,405,1100,135,34,C.teal,true);
txt(s,'e 用常用数据结构承接这些工作，再适应公司的字段、模板与流程',76,581,1100,60,27,C.muted);

s=slide('同一个开票请求，两种处理方式',{note:'本页以单次文件生成方式与 e 的业务流程方式做概念对比，并非声称全部其他 AI 只会 PDF。齿轮代表相互配合的现有结构：Schema 是预置的业务数据模型，DB 保存记录，Workflow 管理文档生命周期，SOP 与工具授权约束 specialist，Template 渲染文件。齿轮是概念关系图，不表示运行时物理依赖或自动创建任意 schema。',source:sources.docs+'; '+sources.agents});
txt(s,'“Create 1 invoice for Acme…”',72,161,1120,55,34,C.teal,true);
txt(s,'单次文件生成',78,239,390,50,30,C.muted,true);
await img(s,'preview/invoice_due-p1.png',132,315,195,257,'单次文件输出：invoice PDF 示例');
txt(s,'1 PDF Invoice',104,581,330,50,30,C.muted,true);
txt(s,'VS',430,414,100,65,38,C.muted,true);
txt(s,'e：按业务流程处理',588,239,620,50,32,C.teal,true);
// The lines express collaboration between editable diagram gears.
for(const [x1,y1,x2,y2] of [[740,365,885,435],[1030,365,885,435],[740,520,885,435],[1030,520,885,435]]){
 s.shapes.add({geometry:'line',position:{left:Math.min(x1,x2),top:Math.min(y1,y2),width:Math.abs(x2-x1),height:Math.abs(y2-y1),verticalFlip:(x2-x1)*(y2-y1)<0},fill:'none',line:{fill:C.gray,width:4}});
}
gear(s,'Schema\n数据结构',658,295,160,C.mint);
gear(s,'Workflow\n流程',952,295,160,C.mint);
gear(s,'SOP\n工作规范',658,452,160,C.mint);
gear(s,'Template\n模板',952,452,160,C.mint);
gear(s,'DB\n业务记录',796,351,180,C.teal);
txt(s,'查记录、补缺项、发行 PDF、保存关联、追踪付款',588,625,620,45,23,C.ink,true);

s=slide('Form 收集数据，e 延续后面的工作',{note:'现有 Form Designer 可建立与发布表单，Form Clerk 可 review、标记 spam、summary 与 export。带语义绑定的客户表单和 order form 可进入客户记录及报价草稿流程。工程日报和每日打卡属于可配置采集场景，不代表完整工单、考勤或薪资系统。任意问题分析是方向，当前以已有统计、摘要和导出工具为准。',source:sources.forms});
txt(s,'工程报告 / 客户订单 / 问卷 / 每日打卡',72,184,1136,60,32,C.teal,true);
const formNode=node(s,'Form\n收集与校验',72,315,225,170,{geometry:'flowChartDocument'});
const dbNode=node(s,'DB\n保存提交',375,315,225,170,{geometry:'can'});
const aiNode=node(s,'专职 AI\n审阅与处理',678,315,225,170,{geometry:'ellipse'});
const outNode=node(s,'工作成果\n记录 / 摘要 / CSV',980,315,225,170,{geometry:'flowChartDocument',size:25});
link(s,formNode,dbNode);link(s,dbNode,aiNode);link(s,aiNode,outNode);
txt(s,'先把信息收进来，再关联客户、文件与下一步工作',76,578,1110,65,32,C.ink,true);

s=slide('业务记录，让团队看见工作状态',{note:'图像来自 repo 中的 CRM dashboard preview，数值为演示数据，不能解读为 Eternalgy 的真实经营表现或客户业绩。代码实现了 outstanding、overdue、billed/collected、quotation pipeline 与 recent documents 等指标。本页用 UI 图像展示输出示例，避免宣称已验证的收益。',source:sources.dashboard});
txt(s,'哪些款项未收？\n哪些 invoice 已逾期？\n哪些 quotation 待跟进？',72,218,550,225,42,C.ink,true);
txt(s,'文件背后的数据\n可以汇总成业务概览',76,486,570,125,31,C.muted);
const dashboardSource=path.join(root,'preview/crm-desktop.png');
const dashboardMeta=await sharp(dashboardSource).metadata();
const dashboardCrop=await sharp(dashboardSource).extract({left:0,top:0,width:dashboardMeta.width,height:Math.round(dashboardMeta.width*418/490)}).png().toBuffer();
s.images.add({blob:new Uint8Array(dashboardCrop),contentType:'image/png',fit:'contain',position:{left:720,top:186,width:490,height:418},alt:'CRM 演示界面局部，所有金额和数量均为演示数据'});
txt(s,'现有界面预览，图中金额与数量为演示数据',722,615,484,45,21,C.muted);

s=slide('一个 Orchestrator，一组专职 AI',{dark:true,note:'Orchestrator 接收需求并派发给 specialist。当前 DI registry 有七个 specialist。Record 与 Document agent 用于主要业务，Forms 与 Intake 用于采集和处理，Onboarding、Templates 和 DB 用于公司设置。所有 agent 共享业务记录，但工具按角色授权。Orchestrator 的外围实现属于 UIv2 host，不把当前子目录说成独立完整 host。',source:sources.agents+'; README.md'});
const orch=node(s,'Orchestrator\n理解需求，安排工作',430,176,420,106,{fill:C.mint,color:C.dark,size:29});
for(const pos of [{left:640,top:282,width:0,height:53},{left:148,top:335,width:984,height:0}]) s.shapes.add({geometry:'line',position:pos,fill:'none',line:{fill:'#5E9585',width:3}});
const labels=['资料\n专员','文件\n专员','表单\n设计','表单\n审阅','公司\n入职','模板\n设计','数据库\n管理'];
for(let i=0;i<labels.length;i++){
 const x=72+164*i;
 s.shapes.add({geometry:'line',position:{left:x+76,top:335,width:0,height:51},fill:'none',line:{fill:'#5E9585',width:3}});
 node(s,labels[i],x,386,152,150,{geometry:'ellipse',fill:'#24594D',size:29});
}
txt(s,'每位 specialist 只使用获授权的工具，共享同一套业务记录',76,617,1110,48,27,C.mint,true);

s=await imageSlide('Stupid = Smart：细胞级 AI','assets/presentation/cellular-human-imagegen.png','创始人的细胞比喻：聪明的人是否要求每个细胞都像人一样聪明？用红血球和大肠细胞作修辞，引出分工与组织产生整体能力。图像是艺术比喻，不对细胞是否具有认知能力作科学断言。e 的目标是把 specialist 限制在可检查的明确任务中，再通过 orchestration 和集成验证形成可靠系统。整体可靠性并不能只由单个单元可靠性推导。','创始人本次提供的细胞级 AI 比喻；'+sources.agents);
txt(s,'聪明的人，\n需要每个细胞都聪明吗？',72,190,740,150,49,C.ink,true);
txt(s,'“聪明的红血球？”\n“聪明的大肠细胞？”',76,394,680,120,34,C.muted);
txt(s,'整体的能力，来自分工与协作',76,603,690,65,35,C.ink,true);

s=await imageSlide('聪明的系统，可以由简单的单元组成','assets/presentation/cellular-ai-comparison-imagegen.png','本页为两种架构思路的概念对比，不将所有竞品归为单一模式。左侧表示持续扩大单个 AI 的职责，右侧表示 e 的 specialist architecture。资料、文件、模板、表单是当前 specialist 职责示例，不是声称每个微任务都有独立 agent。Minimal scope、SOP、工具权限与测试让单元更容易约束，但整体可靠性仍依赖调度、信息交接和系统测试。可靠性为目标，没有已验证的零错误率或速度数值。','core/tools.mjs:16-24,729-737; core/actions.mjs:31-44; '+sources.agents);
txt(s,'扩大一个 AI 的职责',112,154,490,55,31,C.muted,true);
txt(s,'e：组合细胞级 AI',716,154,490,55,31,C.teal,true);
function centeredText(s,label,x,y,w,h,size,color){const t=txt(s,label,x,y,w,h,size,color,true);t.text.style={typeface:font,fontSize:size,color,bold:true,autoFit:'none',alignment:'center',verticalAlignment:'middle'};return t;}
centeredText(s,'一个 AI\n包办所有工作',166,304,270,115,31,C.ink);
txt(s,'VS',583,345,80,65,36,C.muted,true);
centeredText(s,'资料',739,226,110,58,27,C.ink);
centeredText(s,'模板',1057,226,110,58,27,C.ink);
centeredText(s,'文件',739,443,110,58,27,C.ink);
centeredText(s,'表单',1057,443,110,58,27,C.ink);
centeredText(s,'调度\n协作',866,319,160,98,31,C.white);
txt(s,'职责越广，验证组合越多',104,611,495,48,26,C.ink,true);
txt(s,'每个单元：明确任务、SOP、权限与测试',682,611,545,48,25,C.teal,true);

s=slide('公司上下文，连接每一次工作',{note:'本页表达产品的差异化设计选择，避免把一般 AI 都只做模板当作经市场研究证实的事实。公司上下文存在数据与配置中，后续任务可继续用。流程与权限是系统设计选择。不能保证任意任务、任意公司都能自动接入，也不能宣称自动创建任意数据库。',source:sources.docs+'; '+sources.agents});
txt(s,'公司资料决定内容',72,210,1000,65,41,C.ink,true);
txt(s,'公司名称、客户、价格与付款条件来自已保存记录',76,293,1110,65,29,C.muted);
txt(s,'公司规则决定流程',72,394,1000,65,41,C.ink,true);
txt(s,'哪些字段必须补齐、何时发行、谁能使用哪些工具',76,477,1110,65,29,C.muted);
txt(s,'这套上下文可以延续到下一张文件与下一次任务',76,591,1110,55,30,C.teal,true);

s=slide('Document Intelligence 是当前切入点',{note:'必须明确 today vs future。Repo 文档定义 MVP/working demo，host 单一操作员/default company。数据库 tenant-aware 不等于当前支持完整团队用户权限或 tenant switching。MyInvois 只有预备字段，未提交整合。自主判断文档类型、自动扩展 schema、任意问题分析属于待验证方向。',source:sources.limits+'; '+sources.setup});
pair(s,{title:'现有 MVP',body:'客户、商品与文档流程\n付款记录与业务概览\n表单、模板与公司规则\n数据库按 tenant 分隔'}, {title:'下一步产品方向',body:'多人账号与团队权限\n更多重复业务流程\n更自动化的资料 onboarding\n更广泛的业务问答分析'},{top:215});
txt(s,'当前 host：单一操作员、默认公司。MyInvois 尚未整合提交。',76,613,1120,55,24,C.muted);

s=slide('客户试点：先完成一条真实工作流程',{note:'这是建议的试点设计，不是已存在的套餐、价格、期限或客户成果。选 quotation/invoice 或 form intake 其中一条，以现有文件与少量真实记录开始，在 owner 确认后运行。验收比较准备时间、返工、字段完整性和追踪便利程度，不宣称特定节省百分比。多成员使用取决于后续权限能力。'});
txt(s,'已有文件与规则',72,205,1100,65,38,C.teal,true);
txt(s,'用你的 quotation、invoice、客户与商品资料配置 e',76,291,1090,65,31,C.ink);
txt(s,'真实工作与明确验收',72,410,1100,65,38,C.teal,true);
txt(s,'完成一次准备、发行与付款记录，或一次表单采集与处理\n比较准备时间、返工次数和数据完整性',76,496,1110,125,30,C.ink);

s=slide('投资命题：从重复工作验证团队 AI',{note:'这是投资讨论框架，不是经验证的商业表现。切入场景是常见文件与数据采集，扩展依赖 specialist 和公司上下文。待验证项包括 onboarding 成本、真实任务可靠性、持续使用、付费意愿。没有 supplied traction、收入、市场规模、募资额、成本或估值，不能虚构。本 deck 是产品与技术命题介绍，并不是完整融资财务 deck。'});
txt(s,'切入',72,210,180,70,38,C.teal,true);txt(s,'Invoice、quotation 与表单等重复工作',290,210,900,70,34,C.ink);
txt(s,'扩展',72,337,180,70,38,C.teal,true);txt(s,'围绕共同公司上下文，增加可验证的 specialist',290,337,900,85,32,C.ink);
txt(s,'验证',72,482,180,70,38,C.teal,true);txt(s,'三道门槛是否降低，是否带来持续使用与付费意愿',290,482,900,110,32,C.ink);

s=slide('',{dark:true,note:'结尾给两种听众一个清楚的下一步。客户：选一条真实流程做试点。投资者：共同评估 repeat workflow adoption 和实际交付可靠性。产品 slogan 保留创始人原文。'});
txt(s,'e by eternalgy',72,105,1100,105,72,C.white,true);
txt(s,'Let it know,\nLet it Work.',72,270,1120,190,78,C.mint,true);
txt(s,'客户：带一条真实工作流程来试点\n投资者：一起验证团队 AI 的产品路径',76,555,1120,100,30,C.white);

s=slide('资料与产品边界',{note:'来源附录便于 Q&A。所有代码依据均为本地 repo，非 public website。演示截图数据仅展示界面。产品理念来自创始人本次对话。自动 onboarding、任意 schema 和 team access 不混同现有实现。资料截至 2026-10-01。',source:Object.values(sources).join('\n')});
txt(s,'产品理念',72,192,240,55,29,C.teal,true);txt(s,'创始人提供的六个核心理念与团队 AI 定位',352,192,810,70,27,C.ink);
txt(s,'实现依据',72,290,240,55,29,C.teal,true);txt(s,'README.md / ONBOARDING.md / host.mjs\ncore/tools.mjs / documents.mjs / forms.mjs / dashboard.mjs',352,290,810,140,24,C.ink);
txt(s,'证据边界',72,448,240,55,29,C.teal,true);txt(s,'代码与现有预览支持功能说明，不代表部署验收或客户业绩\n截图为演示数据，可靠性和商业指标需在试点中验证',352,448,810,120,25,C.ink);
txt(s,'资料日期：2026-10-01',76,623,1110,40,22,C.muted);

await fs.mkdir(output,{recursive:true});
const candidate=path.join(build,'candidate.pptx');
await (await PresentationFile.exportPptx(p)).save(candidate);
await fs.writeFile(path.join(build,'source.json'),JSON.stringify(p.toProto(),null,2));
await fs.writeFile(path.join(build,'content.json'),JSON.stringify(sources,null,2));
console.log(`Exported candidate: ${p.slides.items.length} slides`);
const final=path.join(output,'e-by-eternalgy-pitch-imagegen.pptx');
const result=await finalizePresentation({workspaceDir:root,candidatePath:candidate,finalPath:final,pythonExecutable:python,
 integrityValidatorPath:path.join(skill,'container_tools/inspect_presentation_package_integrity.py'),
 layoutValidatorPath:path.join(skill,'container_tools/inspect_presentation_layout_geometry.py'),
 layoutArgs:['--expected-slide-size-emu','12192000,6858000','--validate-bullet-geometry','--validate-heading-fit'],
 requiredNativeTableOwnerSlides:[],requiredNativeChartOwnerSlides:[],fontPolicy:{basis:'design',families:[font]},verifyArtifactToolImport:true,
 receiptPath:path.join(build,'validation-imagegen.json')});
console.log(JSON.stringify(result));
const finalDeck=await PresentationFile.importPptx(await FileBlob.load(final));
await fs.mkdir(path.join(build,'render'),{recursive:true});
for(let i=0;i<finalDeck.slides.items.length;i++){
 const png=await finalDeck.export({slide:finalDeck.slides.items[i],format:'png',scale:1});
 await fs.writeFile(path.join(build,'render',`slide-${String(i+1).padStart(2,'0')}.png`),new Uint8Array(await png.arrayBuffer()));
 console.log(`Rendered slide ${i+1}`);
}
