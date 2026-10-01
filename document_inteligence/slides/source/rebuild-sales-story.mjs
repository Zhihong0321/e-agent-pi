import fs from 'node:fs';
const target=new URL('../sales-deck.html',import.meta.url);
const sections=[
`<section class="dark on" aria-label="AI 如何走进公司">
<div class="brand"><b>E</b><span>AGENT AS A SERVICE</span></div>
<div class="top"><p class="eyebrow accent">从能做演示，到能接住日常工作</p><h1>AI 越来越强。<br>为什么公司的工作，<br><span class="accent">还是接不上？</span></h1></div>
<p class="bottom lead">E · 来自三年 AI 自动化实践的回答</p>
<aside>开场提问，不声称有“多数 Agent 失败”的统计。三年实践由创始人在本次对话中提供，也见原 deck.html 的品牌叙述。讲述自己的设计经验，不暗示 E 当前版本已经上线运营三年。下一页用具体工作异常解释问题。</aside></section>`,
`<section aria-label="工作现场的问题">
<p class="eyebrow">我们在实践中关注的三个问题</p><h2>流程写清楚了，<br>现场依然会有这些问题。</h2>
<div class="questions"><div><b>资料</b><h3>“同一个客户，<br>怎么有两份档案？”</h3><p>需要识别资料与关系。</p></div><div><b>规则</b><h3>“这张单少了 PO，<br>能不能开？”</h3><p>需要知道什么条件才算完成。</p></div><div><b>权限</b><h3>“让你改报价，<br>怎么连规则也改了？”</h3><p>需要明确哪些操作属于谁。</p></div></div>
<p class="bottom lead">接入公司工作，要同时接住<span class="underline">资料、规则与责任。</span></p>
<aside>三个场景为示意问题，不是实际客户引言，也不是竞品缺陷调查。分别对应客户匹配、readiness rules 与按权限分工。来源：core/records.mjs:29–138；core/documents.mjs:210–339；core/actions.mjs:29–90。</aside></section>`,
`<section class="lime" aria-label="三年的答案">
<p class="eyebrow">三年 AI 自动化实践，沉淀成两个设计选择</p>
<div class="thesis"><div><span class="thesis-no">01</span><h2>化繁为简</h2><p>把工作交给<br><strong>专职的 micro-agent。</strong></p></div><div><span class="thesis-no">02</span><h2>化简为元</h2><p>先理解工作的原理，<br><strong>再设计执行流程。</strong></p></div></div>
<p class="bottom lead">E 把这两个选择，落实到企业文档工作。</p>
<aside>这页回答“E 为什么采用更好的方法”：这是实践形成的设计判断，不是经过受控对比验证的优越性结论。不承诺更快多少或更准确多少。三年背景由用户提供。接下来分别展开专业分工与工作原理。</aside></section>`,
`<section aria-label="E 在公司里如何工作">
<p class="eyebrow">E 在公司里如何工作</p><h2>员工交代工作，<br>E 连接资料与系统。</h2>
<div class="real-world">
<div class="human-node"><h3>公司员工</h3><p>交代需求<br>补充资料<br>查看结果</p></div>
<div class="link-node"><span>↔</span><p>对话</p></div>
<div class="e-node"><div class="e-node-head"><b>E</b><h3>文档工作 AI</h3></div><p class="built-in">内置文档系统 + 数据库</p><p class="e-capabilities">客户与联系人 · 产品与套餐<br>报价与发票 · 收款记录<br>表单采集 · 汇总与导出</p></div>
<div class="link-node optional-link"><span>↔</span><p>读取<br>写入</p></div>
<div class="external-node"><p class="custom-label">可选 / 按客户定制</p><h3>现有第三方系统</h3><p>云端发票系统、CRM 等</p><p class="integration-scope">连接方式与读写范围<br>依系统接口、授权及需求确定</p></div>
</div>
<div class="real-world-takeaway"><p><b>没有现有系统</b><br>可从 E 的内置功能开始。</p><p><b>已有第三方系统</b><br>按客户单独评估与定制对接。</p></div>
<p class="bottom footnote muted">HR、薪资、法务等扩展场景需另行评估，不属于当前内置功能。</p>
<aside>本页根据用户提供的 Human Employee ↔ E ↔ optional third-party system 架构图重绘。用户明确第三方系统连接属于每客户单独定制，不是即开即用或任意系统通用连接。双向箭头表示沟通与可评估的读写方向，不承诺实时双向同步。内置范围按当前代码列出：客户、产品、报价、发票、收款与表单。原参考图中的 HR、Payroll、Legal 为扩展方向，当前未实现完整业务模块，故在页面明确。E 自带数据库，不要求客户先拥有第三方系统。来源：本次用户说明及附件；README.md 第2、4、5、9节。商业接口开发范围与费用应在具体客户需求中确认。</aside></section>`,
`<section class="dark" aria-label="专职微代理">
<p class="eyebrow accent">化繁为简 / 专业分工</p><h2>你看到 E。<br>背后，是各司其职的 AI 团队。</h2>
<div class="team"><div><b>01</b><h3>资料员</h3><p>客户、联系人、产品与套餐</p></div><div><b>02</b><h3>单据专员</h3><p>报价、发票与收款记录</p></div><div><b>03</b><h3>模板设计师</h3><p>文件版式与模板版本</p></div><div><b>04</b><h3>规则管理员</h3><p>公司设置与开单规则</p></div><div><b>05</b><h3>表单设计师</h3><p>设计、发布与更新表单</p></div><div><b>06</b><h3>表单收件员</h3><p>审阅、汇总与导出提交</p></div></div>
<p class="bottom lead accent">每个 micro-agent 负责一类工作，共用同一套业务数据。</p>
<aside>六个 agent 对应 di-records、di-documents、di-templates、di-db、di-forms、di-intake。不是六个任意自治协作模型的承诺；有直接进入不同 agent 的入口，部分任务可由 Orchestrator 转交，图片转交未支持。“你看到 E”指产品品牌，非已验证所有任务都单入口无缝路由。来源：README.md 第2节；core/tools.mjs；host.mjs:291–329。</aside></section>`,
`<section aria-label="分工的价值">
<p class="eyebrow">专职，意味着知识与权限都有范围</p><h2>负责开单的，<br>就把开单这件事做好。</h2>
<div class="split" style="margin-top:56px;align-items:start"><div><p class="quote">“帮我给这位客户<br>准备一份报价。”</p><p class="lead muted" style="margin-top:35px">单据专员查客户、查产品，<br>检查缺项，再起草。</p></div><div><div class="step"><b>知道什么</b><p>客户、产品、价格与单据状态</p></div><div class="step"><b>能做什么</b><p>用指定工具处理单据</p></div><div class="step"><b>谁来改规则</b><p>交给规则管理员</p></div></div></div>
<p class="bottom lead">范围清楚，才更容易检查它有没有把事情做对。</p>
<aside>按权限拆分，不按“创建”与“修改”动词拆分。单据专员同时负责 draft/update/issue/payment，不能改公司规则。host 端授权防止借用其他 agent 工具。来源：core/actions.mjs:29–90。关于更容易验证是设计理由，非量化性能结论。</aside></section>`,
`<section class="lime" aria-label="理解工作的原理">
<p class="eyebrow">化简为元 / 工作的原理</p><h1 style="margin-top:58px;font-size:106px">先弄懂<br>这份工作<span class="underline">是什么</span>，<br>再决定怎么做。</h1>
<div class="bottom"><p class="lead">以开单为例：谁在买？买什么？按什么价格？<br>什么时候可以正式开立？之后如何知道有没有收款？</p></div>
<aside>此处“理解原理”指产品建模方法：开发者把业务实体、关系、规则、状态设计成数据模型和工具供 agent 使用。不是声称语言模型可以凭空推导任意行业原理。流程依然重要，只是在业务定义基础上设计。README.md 第1、4、5节。</aside></section>`,
`<section aria-label="发票的原理">
<p class="eyebrow">把“开发票”拆回它的业务事实</p><h2>一张发票，<br>连接的是一笔真实交易。</h2>
<div class="facts"><div><b>谁</b><h3>客户与联系人</h3><p>交易对象是谁</p></div><span>+</span><div><b>什么</b><h3>产品、数量、价格</h3><p>这笔交易卖了什么</p></div><span>+</span><div><b>多少</b><h3>税额与应付金额</h3><p>应该支付多少</p></div><span>→</span><div><b>进度</b><h3>单据与收款状态</h3><p>这笔交易走到哪里</p></div></div>
<p class="bottom lead">这些事实有了清楚的关系，报价、发票与收款才接得起来。</p>
<aside>概念关系图，非数据库精确 ER 图。付款是独立记录，通过 payment_allocation 关联发票；报价可转发票。客户与公司快照在 issue 时冻结，明细包含价格与税额。core/documents.mjs:353–393、468–601；sql/001_core.sql。</aside></section>`,
`<section class="dark" aria-label="从数据库理解文档工作">
<p class="eyebrow accent">E 从数据库层面，组织文档工作</p><h2>资料从哪里来，<br>存在哪里，下一步怎么用。</h2>
<div class="data-work"><div><b>采集</b><p>用表单收集<br>客户资料与订单</p></div><div><b>存储</b><p>按客户、产品、<br>单据分别归档关联</p></div><div><b>读取</b><p>查找已有资料、<br>规则与业务状态</p></div><div><b>创建</b><p>按规则生成<br>新的业务记录</p></div><div><b>呈现</b><p>输出报价、发票、<br>汇总与 PDF</p></div></div>
<div class="database-line"><span>一套有结构、有关系的业务数据</span></div>
<p class="bottom small muted">Agent 通过受限工具操作，关键规则由系统执行。</p>
<aside>五个能力维度，不是每次任务强制走一遍的线性流程；共用数据层表示统一模型。Agent 不直接运行 SQL，也不修改表结构。工具在主机事务内执行，表单通过服务器校验后入库。来源：core/actions.mjs:29–90；core/forms.mjs:754–797、1084–1178；core/documents.mjs:210–339、353–393、606–613。</aside></section>`,
`<section aria-label="一个订单的例子">
<p class="eyebrow">把原理放进日常工作 / 示例</p><h2>客户填下的订单，<br>成为下一张报价的依据。</h2>
<div class="order-demo"><div class="order-paper"><p class="tag">订单表单 · 示例</p><div class="docrow"><span>客户</span><strong>Acme</strong></div><div class="docrow"><span>产品</span><strong>太阳能板</strong></div><div class="docrow"><span>数量</span><strong>18 块</strong></div><p class="small muted" style="margin-top:23px">已设定字段与产品关联</p></div><span class="bridge-arrow">→</span><div><div class="step"><b>查</b><p>客户、产品与目录价格</p></div><div class="step"><b>问</b><p>开单还缺什么资料</p></div><div class="step"><b>建</b><p>生成关联这份订单的报价草稿</p></div><p class="small muted" style="margin-top:24px">按你的指示继续：报价接受 → 发票 → 登记收款</p></div></div>
<p class="bottom lead">资料进入系统后，可以继续用于下一项工作。</p>
<aside>Acme、产品与数量为演示数据。订单字段 binds_to 提供 customer.name 和 line.SKU.quantity；prepare_document 读取，create_draft 链接原提交并标记 processed。不是提交后自动运行整条流程；用户需指示操作与补全资料。来源：core/forms.mjs:1151–1178；core/documents.mjs:210–339、353–393。客户档案需存在或先通过资料员建立。</aside></section>`,
`<section aria-label="公司的做法">
<p class="eyebrow">原理相通，公司做法可以不同</p><h2>共用业务基础，<br>保留你公司的规矩。</h2>
<div class="split" style="margin-top:54px;align-items:start"><div><p class="eyebrow muted">共同基础</p><p class="quote">客户是谁<br>交易是什么<br>单据到哪一步</p></div><div><p class="eyebrow muted">按公司设置</p><div class="listline">必须填写的资料与开单条件</div><div class="listline">产品、套餐、价格与税码</div><div class="listline">单号格式与文件版式</div></div></div>
<p class="bottom lead">把公司的要求设成依据，让每次操作有规则可循。</p>
<aside>支持标准业务结构上的配置，包括自定义字段与固定检查词汇。不是任意行业 ERP 定制或任意 DDL。字段类型、workflow rules、编号、税码、模板由指定 agent 的工具操作。来源：README.md 第5节；core/admin.mjs；core/workflows.mjs。</aside></section>`,
`<section class="dark" aria-label="今天可以开始的工作">
<p class="eyebrow accent">E DOCUMENT INTELLIGENCE / 当前可演示</p><h2>从一项日常工作开始，<br>验证它能不能接住。</h2>
<div class="demo-choices"><div><b>01</b><h3>客户建档</h3><p>名片或表单<br>→ 客户与联系人</p></div><div><b>02</b><h3>报价到收款</h3><p>报价 → 发票<br>→ 收款记录</p></div><div><b>03</b><h3>表单收件</h3><p>发布 → 收集<br>→ 审阅与汇总</p></div></div>
<p class="lead" style="margin-top:45px">一起看：资料是否正确，规则是否满足，下一步是否接得上。</p>
<p class="bottom footnote muted">当前为单操作员 MVP。MyInvois 提交、多用户权限、收款更正与完整信用票据流程尚未提供。</p>
<aside>避免以实验室通过率代表生产可靠性。可用用户脱敏示例进行演示。合同、部署、支持时段、服务范围与价格尚未定义，不作服务承诺。保存的评测为 28/30 与表单 14/16，仅用于必要时回答评测问题，来源 all-test-results.md。线上端到端尚待验证。</aside></section>`,
`<section class="lime" aria-label="把工作带来">
<div class="brand"><b>E</b><span>EASY, EFFICIENT, EVER READY.</span></div>
<div class="top"><h1 style="font-size:105px">带来一项<br>你想交给 AI 的工作。</h1><p class="lead" style="margin-top:42px">我们先看它的原理，再演示 E 如何处理。</p></div>
<div class="bottom"><p class="quote">需要什么资料？　遵守什么规则？<br>怎样才算真正做完？</p><p class="small" style="margin-top:40px">专职 micro-agent · 有结构的业务数据 · 有依据的执行</p></div>
<aside>邀请观众选一个当前支持范围内的文档工作，带报价样本、产品或表单需求。这里是演示邀请，不承诺所有工作均可立即支持。不填未经确认的价格、二维码、联系方式。</aside></section>`
];
const extra=`
.real-world{display:grid;grid-template-columns:200px 90px 480px 100px 430px;gap:25px;align-items:center;margin-top:43px}.real-world h3{font-size:29px}.human-node{border-top:3px solid #77924b;padding:26px 0}.human-node p{font-size:24px;line-height:1.8;margin-top:20px;color:#637368}.link-node{text-align:center}.link-node span{font-size:62px;color:#6e864d;line-height:1}.link-node p{font-size:20px;margin-top:12px;color:#607260}.e-node{background:var(--ink);color:var(--paper);padding:27px 32px}.e-node-head{display:flex;gap:22px;align-items:center}.e-node-head b{font-size:68px;color:var(--lime);line-height:1}.built-in{font-size:25px;margin-top:22px;border-top:1px solid #617454;padding-top:20px;color:var(--lime)}.e-capabilities{font-size:22px;line-height:1.8;margin-top:15px}.external-node{border:2px dashed #a2ae90;padding:28px 24px}.external-node .custom-label{font-size:20px;color:#6b803f;margin-bottom:21px}.external-node>p{font-size:23px;margin-top:15px}.external-node .integration-scope{font-size:19px;line-height:1.65;color:#667568;margin-top:23px}.real-world-takeaway{display:grid;grid-template-columns:1fr 1fr;gap:80px;margin-top:35px}.real-world-takeaway p{font-size:23px;line-height:1.7}.real-world-takeaway b{font-size:25px}
.questions{display:grid;grid-template-columns:repeat(3,1fr);gap:70px;margin-top:65px}.questions b{font-size:22px;color:#748554;display:block;margin-bottom:25px}.questions h3{font-size:34px;line-height:1.65}.questions p{font-size:24px;color:#67776b;margin-top:24px}.thesis{display:grid;grid-template-columns:1fr 1fr;gap:100px;margin-top:70px}.thesis>div+div{border-left:1px solid #7b9451;padding-left:80px}.thesis-no{display:block;font-size:100px;color:#6c843c;margin-bottom:24px;line-height:1}.thesis p{font-size:36px;line-height:1.65;margin-top:30px}.team{display:grid;grid-template-columns:repeat(3,1fr);gap:42px 60px;margin-top:45px}.team>div{border-top:1px solid #4e6255;padding-top:20px}.team b{font-size:18px;color:var(--lime);display:block;margin-bottom:9px}.team h3{font-size:32px}.team p{font-size:22px;color:var(--muted);margin-top:8px}.facts{display:grid;grid-template-columns:1fr 40px 1fr 40px 1fr 40px 1fr;gap:10px;align-items:center;margin-top:95px}.facts b{font-size:58px;color:#769347}.facts h3{font-size:28px;margin-top:25px}.facts p{font-size:21px;color:#67776b;margin-top:15px}.facts>span{font-size:32px;color:#81906f}.data-work{display:grid;grid-template-columns:repeat(5,1fr);gap:35px;margin-top:78px}.data-work b{font-size:54px;color:var(--lime)}.data-work p{font-size:25px;line-height:1.7;margin-top:25px}.database-line{border-top:2px solid #7a9460;margin-top:42px;text-align:center;padding:23px;font-size:27px;letter-spacing:4px}.order-demo{display:grid;grid-template-columns:500px 90px 1fr;gap:45px;align-items:center;margin-top:48px}.order-paper{background:#fffdf8;padding:32px 40px;border-top:6px solid #809957}.bridge-arrow{font-size:70px;color:#7d9450}.demo-choices{display:grid;grid-template-columns:repeat(3,1fr);gap:70px;margin-top:55px}.demo-choices b{font-size:55px;color:var(--lime)}.demo-choices h3{margin:18px 0;font-size:34px}.demo-choices p{font-size:28px;line-height:1.65}.step>b{white-space:nowrap}h1,h2{letter-spacing:-3px}
`;
let html=fs.readFileSync(target,'utf8');
html=html.replace(/<main id="stage">[\s\S]*?<\/main>/,`<main id="stage">\n${sections.join('\n')}\n</main>`);
html=html.replace(/<style id="story-style">[\s\S]*?<\/style>/,'').replace('</head>',`<style id="story-style">${extra}</style></head>`);
html=html.replace('<title>E · 把文档工作交给 AI</title>','<title>E · 先理解工作，再让 AI 执行</title>');
fs.writeFileSync(target,html);
console.log(`Rebuilt ${sections.length} slides`);
