import fs from 'node:fs/promises';
const path=new URL('./deck.html',import.meta.url);
let html=await fs.readFile(path,'utf8');
const sections=[];
function slide(title,time,body,notes,dark=false){sections.push(`<section class="slide${sections.length===0?' active':''}${dark?' dark':''}" data-title="${title}" data-time="${time}">${body}<aside class="speaker">${notes}</aside></section>`)}
slide('Eternalgy Agentic AI：启动市场化规划','0:50',`
<div class="cover-title"><p class="eyebrow">管理层策略讨论</p><h1>Eternalgy<br>Agentic AI</h1><div class="cover-line"></div><p class="cover-cn">快 · 好 · 美 · 省<br>让中小企业拥有自己的数字员工。</p></div><p class="cover-meta">从内部应用走向市场 · 2026 年 9 月</p>`,
`今天要讨论的是 Eternalgy Agentic AI 产品与服务的市场化规划。核心技术主张是快、好、美、省同时成立：工作完成得快、结果可靠、交付精美、运行成本低。网站团队是进入市场的第一项服务，是能力的例子，不是整个产品的边界。`);

slide('我们已经走到哪里','1:00',`
<p class="eyebrow">01 / 当前进展</p><h2>产品已在内部使用，<br>技术接近市场化准备阶段。</h2><p class="lead">先把实际工作做出来，再讨论如何对外销售。</p>
<div class="rail" style="grid-template-columns:repeat(3,1fr);margin-top:76px"><div class="rail-item"><span class="seq">01</span><h3>搭好基础</h3><p>接入工具与业务资料，<br>建立专业 Agent 与交付规范。</p></div><div class="rail-item"><span class="seq">02</span><h3>内部实际使用</h3><p>在真实工作中持续调整，<br>积累可复用的执行经验。</p></div><div class="rail-item"><span class="seq">03</span><h3>启动商业规划</h3><p>确定卖给谁、卖什么，<br>以及如何交付和收费。</p></div></div><p class="bottom-line">我们现在要跨出的，是从内部能力到对外服务的一步。</p>`,
`原计划的重点是将内部使用视为已有积累。产品方确认技术与产品接近就绪，但尚未提供运营月份、任务总量或活跃人数，因此不编造这些数字。内部使用为我们提供经验，对不同 SME 的适配仍需对外验证。`);

slide('实际交付证明：Clioart 网站','1:30',`
<p class="eyebrow">02 / 实际交付证明</p><h2>25 分钟完成网站，<br>Token 成本 RM1–RM1.50。</h2>
<div style="display:grid;grid-template-columns:1.25fr 1fr;gap:55px;margin-top:38px"><img class="site-shot" src="__SITE_IMAGE__" alt="Clioart Printing 实际网站首页" style="height:467px;object-fit:cover;object-position:top"><div><h3>Clioart Printing</h3><p class="small" style="margin-top:10px">Google PageSpeed Insights · 桌面端</p><div class="scoreline" style="grid-template-columns:1fr 1fr;gap:28px;margin-top:30px"><div class="score"><strong style="font-size:66px">98</strong><p>性能</p></div><div class="score"><strong style="font-size:66px">92</strong><p>无障碍</p></div><div class="score"><strong style="font-size:66px">100</strong><p>最佳实践</p></div><div class="score"><strong style="font-size:66px">100</strong><p>SEO 基础</p></div></div><p style="margin-top:25px"><a class="source-link" target="_blank" rel="noopener" href="https://ee-html.up.railway.app/app/clioart-printing-sdn-bhd/">查看实际交付网站 ↗</a></p></div></div><p class="note">时间与 Token 成本由项目方提供；分数来自 2026-09-08 桌面测试截图。Token 成本不包含托管、支持与获客。</p>`,
`这个案例同时支撑四个维度：25 分钟体现快；技术测试提供好的部分证据；现场展示的设计体现美；RM1–RM1.50 的 Token 消耗体现省。美需要看实际成品，不能由性能分数代替。单个案例不能推导普遍交付时间或利润率；人工介入尚未单独记录。截图实际是98、92、100、100，已修正最初的四个100说法。SEO分数不是排名保证。案例：https://ee-html.up.railway.app/app/clioart-printing-sdn-bhd/`);

slide('为什么现在开始规划','1:00',`
<p class="eyebrow">03 / 为什么是现在</p><h2>我们已经能交付成果。<br>下一步，验证市场愿不愿意买单。</h2>
<div class="split" style="margin-top:80px"><div class="pill-free"><h3>技术端：已有具体能力</h3><p class="lead">专业 Agent、工具接入与交付规范，<br>已能组合成实际服务。</p><p class="body" style="margin-top:30px">网站案例给出了速度、成本<br>与成品质量的具体证据。</p></div><div class="pill-free"><h3>市场端：还有落地空间</h3><p class="lead">中小企业需要完成业务工作，<br>需要有人把 AI 变成可用服务。</p><p class="body" style="margin-top:30px">我们的机会，是把已有能力<br>包装成容易购买与使用的交付。</p></div></div><p class="bottom-line">现在开始接触客户，才能把技术优势转化成商业经验。</p>`,
`保留原计划为什么现在的逻辑，但不使用没有数据支持的马来西亚 SME 采用率接近零或必然抢占品类等绝对说法。我们掌握的事实是已能交付一个网站，技术接近就绪；市场机会是待验证的商业判断。现在应着手客户访谈、服务方案和试点。`);

slide('市场缺口：中小企业的使用门槛','1:00',`
<p class="eyebrow">04 / 市场缺口</p><h2>老板要的是工作完成。<br>学习新系统，本身也是成本。</h2><p class="lead">目标客户：希望使用 AI，却不想增加一套复杂操作流程的中小企业。</p>
<div class="three" style="margin-top:72px"><div class="pill-free"><h3>学习成本</h3><p class="body">新界面、新功能，<br>还要学会怎么问 AI。</p></div><div class="pill-free"><h3>适应成本</h3><p class="body">调整工作方式，<br>把资料搬进新的系统。</p></div><div class="pill-free"><h3>收尾成本</h3><p class="body">AI 给了内容，<br>仍要自己整理成成品。</p></div></div><p class="bottom-line">产品必须同时解决“容易开始”和“完整交付”。</p>`,
`回到原计划 SME 使用门槛这一页。不要断言所有老板都没有 IT 部门，而是定义我们针对的客户：不愿承担复杂学习与适应成本的企业。市场缺口不只是缺少一个聊天机器人，还包括 AI 输出之后的实际执行与收尾。`);

slide('我们的答案：熟悉的聊天方式','1:10',`
<p class="eyebrow">05 / 我们的答案</p><h2>像发消息一样，<br>把工作交给 AI。</h2><p class="lead">沿用 WhatsApp 式的聊天习惯：选对话、输入需求、发送。</p>
<div style="margin-top:48px"><p class="quote">“参考这个网站，帮我做好公司的官网。”</p><p class="quote">“研究这家竞争对手，整理适合我们的内容。”</p><p class="quote">“再做一个中文版本，并更新产品资料。”</p></div><p class="bottom-line">用户端：尽量接近零培训。交付端：把整份工作完成。</p>`,
`原计划的 WhatsApp 熟悉感必须保留。这里说的是 WhatsApp 式聊天界面与使用习惯，不暗示所有服务必须原生运行在 WhatsApp 内，也不把 WhatsApp Business API 作为唯一入口。三句话是示例指令。接近零培训是产品目标，不代表客户不需要提供资料或确认结果。`);

slide('核心竞争优势：快好美省','2:10',`
<p class="eyebrow">06 / 核心竞争优势</p><h2>快、好、美、省。<br>四个维度，一起做好。</h2>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:40px 75px;margin-top:48px">
<div style="display:grid;grid-template-columns:110px 1fr;gap:24px;border-top:1px solid #536056;padding-top:24px"><span style="font-size:100px;line-height:1.1;color:#c7dab8">快</span><div><h3>专注任务，快速完成</h3><p class="body" style="margin-top:12px">专业 Agent 缩短执行路径。<br>网站案例：25 分钟完成。</p></div></div>
<div style="display:grid;grid-template-columns:110px 1fr;gap:24px;border-top:1px solid #536056;padding-top:24px"><span style="font-size:100px;line-height:1.1;color:#c7dab8">好</span><div><h3>范围明确，交付可靠</h3><p class="body" style="margin-top:12px">按明确步骤执行与检查，<br>减少遗漏，提高稳定性。</p></div></div>
<div style="display:grid;grid-template-columns:110px 1fr;gap:24px;border-top:1px solid #536056;padding-top:24px"><span style="font-size:100px;line-height:1.1;color:#c7dab8">美</span><div><h3>精美成品，直接使用</h3><p class="body" style="margin-top:12px">把结果做成专业网页与报告，<br>版式、信息呈现都经过设计。</p></div></div>
<div style="display:grid;grid-template-columns:110px 1fr;gap:24px;border-top:1px solid #536056;padding-top:24px"><span style="font-size:100px;line-height:1.1;color:#c7dab8">省</span><div><h3>低价模型，完成高价值工作</h3><p class="body" style="margin-top:12px">释放便宜、快速模型的能力。<br>案例 Token：RM1–RM1.50。</p></div></div>
</div><p class="note">这四项共同定义我们的产品优势：交付速度、结果质量、成品设计与运行经济性。</p>`,
`这是整套演示的核心，应留足两分钟解释。快是响应及端到端完成速度，专业范围让模型少做无关工作。好是任务范围、步骤、工具和验证清楚，减少遗漏并提高稳定性，不意味着绝对不出错。美是输出本身经过设计，网页、报告都应成为可直接使用的成品，美和好不能合并。省是用便宜、快速模型做有价值任务，并减少客户学习与整理负担。25分钟及RM1–RM1.50是具体案例证据，质量与稳定性收益仍需持续量化。四者一起成立来自专业分工及工程基础，不是只靠更强、更贵的模型。`,true);

slide('细胞级设计为什么支撑快好美省','1:50',`
<p class="eyebrow">07 / 优势从哪里来</p><h2>一个熟悉的入口，<br>背后一组专业数字员工。</h2><p class="lead">细胞级 Agent：每个专员有清楚的工作范围、工具与交付标准。</p>
<table class="matrix"><thead><tr><th>我们如何设计</th><th>带来的产品优势</th></tr></thead><tbody><tr><td>缩小任务范围</td><td><strong class="accent">快</strong>　少绕路，把执行集中在当前工作。</td></tr><tr><td>固定步骤与检查</td><td><strong class="accent">好</strong>　行为更可控，减少遗漏与不稳定。</td></tr><tr><td>为输出制定设计规范</td><td><strong class="accent">美</strong>　专业网页与报告，形成可直接使用的成品。</td></tr><tr><td>按任务匹配模型与工具</td><td><strong class="accent">省</strong>　让低成本模型承担适合的工作。</td></tr></tbody></table><p class="bottom-line">复杂性由我们处理，客户只需提出任务。</p>`,
`这一页逐行解释快好美省的成因，避免对非技术管理层只说架构名词。窄范围限制无关思考；步骤、工具和检查提高可控性；设计规范保证输出呈现；任务匹配减少不必要的高成本模型消耗。原计划强调一个界面、多种专业 Agent；这不等于承诺每个任务都由同一个聊天机器人自动路由，具体选择方式遵循实际产品。用户提到设计使用 Kimi，模型名称不是商业核心，因此此处强调按任务选能力。`);

slide('从操作工具，到管理数字员工','1:20',`
<p class="eyebrow">08 / 产品定位</p><h2>客户当主管，<br>AI 当执行工作的数字员工。</h2>
<table class="matrix" style="margin-top:68px"><thead><tr><th style="width:28%">角色变化</th><th style="width:32%">操作工具</th><th>委派数字员工</th></tr></thead><tbody><tr><td>客户做什么</td><td>学习功能，逐步操作</td><td>说明目标，提供资料</td></tr><tr><td>谁执行工作</td><td>客户自己操作完成</td><td>AI 执行具体任务</td></tr><tr><td>客户获得什么</td><td>可使用的功能</td><td>完成的工作成果</td></tr><tr><td>后续怎么做</td><td>继续手动调整</td><td>查看成果，再委派修改</td></tr></tbody></table><p class="bottom-line">我们销售的价值：有人接下任务，并把它做完。</p>`,
`恢复原计划工具到助手、老板是主管这一层产品定位。用户将其形容为 Digital Robot。商业解释是客户委派目标而系统承担执行，不只是卖一种功能或一段生成文本。完整交付是产品方向，但权限、客户确认与人工异常处理仍需要作为服务设计的一部分。`);

slide('从马来西亚企业的真实工作出发','1:20',`
<p class="eyebrow">09 / 本地业务基础</p><h2>从马来西亚企业的<br>真实工作需求出发。</h2>
<div class="split" style="margin-top:55px"><div><h3>已积累的业务场景</h3><div class="list-row"><span class="num">01</span><div><h3>TNB 与太阳能</h3><p>电费检查、Solar PV 回报计算。</p></div></div><div class="list-row"><span class="num">02</span><div><h3>日常经营</h3><p>WhatsApp 运营、销售与广告相关工作。</p></div></div><p class="small" style="margin-top:22px">从具体业务逻辑开始积累。</p></div><div class="pill-free"><p class="eyebrow" style="margin-top:0">首个商业服务</p><h3 style="font-size:44px">AI 网站团队</h3><p class="body" style="margin-top:25px">参考资料 → 设计制作 → 质量检查<br>支持多语言网站，规划持续管理。</p><p class="body" style="margin-top:25px">project-bedrock 提供技术质量规范。<br>AI 接待员可作为后续拓展。</p></div></div>`,
`原计划列出 TNB、Solar PV、WhatsApp 运营及销售广告等本地场景，保留这些产品基础，不把整个产品缩小成网站生成器。它们是原计划提供的场景，不表示全部已完成外部付费验证。采访确定的第一个销售入口是网站团队，支持客户直接委派、多语言，之后持续管理。Bedrock 公共标准检查性能、无障碍、基础规范和SEO；设计由设计能力负责。AI接待员是可选拓展，不宣称已经完整验证。参考：https://github.com/Zhihong0321/project-bedrock`);

slide('我们的竞争优势与复制门槛','1:40',`
<p class="eyebrow">10 / 竞争优势与护城河</p><h2>低成本的完整交付，<br>加上快速定制的能力。</h2>
<table class="matrix"><thead><tr><th>竞争维度</th><th>我们的优势主张</th></tr></thead><tbody><tr><td>运行经济性</td><td>让低价、快速模型完成高价值任务，支撑长期服务。</td></tr><tr><td>任务完成能力</td><td>连接工具、业务资料与执行步骤，把工作交到终点。</td></tr><tr><td>精美输出</td><td>专业网页与报告成为交付物，减少客户整理加工。</td></tr><tr><td>定制与复用</td><td>复用底层基础，快速创建新的专业 Agent 类型。</td></tr></tbody></table><p class="bottom-line">复制最终界面很容易；重建可靠交付所需的基础，需要积累。</p><p class="note">下一步验证重点：这些优势能否在不同 SME 的实际工作中持续成立。</p>`,
`竞争讨论回到用户的七点：低成本、端到端、数字员工、基础接线的门槛、快速创建新Agent、细胞级架构和低运行成本。面对依赖更昂贵模型的方案，我们强调任务匹配后的经济性；面对通用AI，我们强调已经接好的具体工作。未经同条件测试，不写某品牌绝对无法复制。公开的Bedrock本身不是独占资产，护城河是整合、业务规范、执行经验和持续改进。原计划的一家公司到多家SME验证限制保留在页尾。`);

slide('市场化前，需要补齐的服务能力','1:10',`
<p class="eyebrow">11 / 商业化准备</p><h2>技术接近就绪，<br>服务体系需要同步建立。</h2>
<div style="margin-top:40px"><div class="list-row"><span class="num">01</span><div><h3>客户数据与权限</h3><p>不同企业的资料分开管理，明确谁能执行与确认。</p></div></div><div class="list-row"><span class="num">02</span><div><h3>完整成本与收费</h3><p>计入模型、托管、渠道及人工支持，形成套餐与价格。</p></div></div><div class="list-row"><span class="num">03</span><div><h3>获客与试点</h3><p>找到首批 SME，验证需求、付费意愿与交付效果。</p></div></div><div class="list-row"><span class="num">04</span><div><h3>支持与责任范围</h3><p>定义修改次数、响应时间、异常处理与服务承诺。</p></div></div></div>`,
`保留原计划商业化前要解决的问题，用管理层能理解的语言表达。多租户说成客户数据与权限。WhatsApp渠道若采用商业API，相关费用应计入完整成本，不复述原稿中可能过时的按对话计价说法。这是商业规划清单，不是当前代码缺陷清单，也不推定所有功能都没有实现。`);

slide('市场进入路径：从外层到核心','1:30',`
<p class="eyebrow">12 / 市场进入路径</p><h2>从企业“外层”切入，<br>赢得信任，再深入核心工作。</h2><div class="rail"><div class="rail-item"><span class="seq">01</span><h3>网站团队</h3><p>建站与持续管理<br>先交付看得见的成果</p><p class="phase">首个商业入口</p></div><div class="rail-item"><span class="seq">02</span><h3>社交媒体</h3><p>内容与日常运营<br>持续参与品牌沟通</p><p class="phase">后续扩展</p></div><div class="rail-item"><span class="seq">03</span><h3>广告服务</h3><p>参与推广与获客<br>承担更多经营责任</p><p class="phase">后续扩展</p></div><div class="rail-item"><span class="seq">04</span><h3>定制 Agent</h3><p>客户提出自动化需求<br>进入具体内部流程</p><p class="phase">核心工作</p></div></div><p class="bottom-line" style="margin-top:50px">用快好美省的交付，换来信任与更多委派。</p>`,
`按采访修订原计划的路线图。用户明确以网站进入，再做社交媒体、广告，最后接客户自定义自动化工作。每个阶段以前一阶段的交付和信任为基础。首批客户、具体周期和预算尚未确定。本页讲销售扩展路径，不声称四项服务今天已全部商品化。`);

slide('今天的决定：启动市场化规划','1:00',`
<p class="eyebrow">13 / 今天希望达成的共识</p><h2 style="font-size:75px;margin-top:35px">启动 Eternalgy Agentic AI<br>产品与服务的<br><span class="accent">市场化策略规划。</span></h2><div class="rule" style="margin-top:54px"></div><div class="three"><div><h3>确定首批客户</h3><p class="lead">先接触哪类 SME？<br>如何取得第一笔订单？</p></div><div><h3>形成服务方案</h3><p class="lead">网站团队卖什么？<br>如何定价与支持？</p></div><div><h3>安排推进责任</h3><p class="lead">谁牵头？<br>何时带回第一版方案？</p></div></div>`,
`用户明确本次不是要求特定预算或员工数，而是希望开始规划AI产品与服务的GTM策略。将决定收敛成首批客户、服务方案与责任安排，不擅自设定日期或金额。此页可停下来请管理层确认负责人，并约定回报时间。`);

slide('愿景：每家企业都能拥有数字员工','0:50',`
<p class="eyebrow">14 / 愿景</p><h2 style="font-size:76px;margin-top:45px">让中小企业，<br>也能拥有自己的<br><span class="accent">专业数字员工团队。</span></h2><div class="rule" style="margin-top:54px"></div><p style="font-size:58px;letter-spacing:15px;color:#c7dab8">快 · 好 · 美 · 省</p><p class="lead" style="margin-top:30px">从一个网站开始，走向更多经营工作。<br>把已经积累的技术能力，带到真实市场中。</p><p class="note">讨论：如何把这一步走出去？</p>`,
`恢复原计划以愿景收束的安排，而不是用网站服务清单结束。公司具备一组专业数字员工的产品方向，网站是起点，目标是支持更多企业经营工作。如果在马来西亚验证成立，将来可以探索其他行业与市场，但不承诺未经验证的规模。用快好美省再次总结核心主张，并进入管理层讨论。`,true);

if(sections.length!==15)throw Error('Expected 15 slides');
html=html.replace(/<section class="slide active"[\s\S]*?<\/section>[\s\S]*?(?=\n<\/div><\/div><\/main>)/,sections.join('\n\n'));
await fs.writeFile(path,html);
console.log('Restored original 15-slide narrative, incorporating interview updates.');
