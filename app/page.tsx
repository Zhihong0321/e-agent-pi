"use client";

import { useState } from "react";

type AgentId = "quotation" | "prospecting" | "customer" | "followup" | "insights";
type View = "agents" | "menu" | "chat" | "tasks" | "approvals" | "library";

type Agent = {
  id: AgentId;
  name: string;
  short: string;
  headline: string;
  description: string;
  color: string;
  time: string;
  unread?: number;
  tools: string;
  actions: { title: string; description: string; icon: string }[];
};

const agents: Agent[] = [
  {
    id: "quotation", name: "Quotation Agent", short: "Q", color: "emerald", time: "11:42 AM", unread: 2,
    headline: "QT-1048 is ready for approval",
    description: "Creates, reviews and manages quotations",
    tools: "CRM · Product catalogue · Pricing rules",
    actions: [
      { icon: "+", title: "New Quotation", description: "Create a customer-ready quote with AI" },
      { icon: "▤", title: "Your Quotations", description: "Drafts, approvals and sent quotations" },
      { icon: "✦", title: "Chat to AI", description: "Ask about pricing, products or policies" },
    ],
  },
  {
    id: "prospecting", name: "Prospecting Agent", short: "P", color: "blue", time: "10:18 AM", unread: 1,
    headline: "12 matching leads found for you",
    description: "Discovers and qualifies potential customers",
    tools: "Lead database · CRM · Company research",
    actions: [
      { icon: "⌕", title: "Find New Leads", description: "Describe your ideal customer to AI" },
      { icon: "♙", title: "My Leads", description: "Review qualified prospects and signals" },
      { icon: "✦", title: "Chat to AI", description: "Research a market, company or person" },
    ],
  },
  {
    id: "customer", name: "Customer 360 Agent", short: "C", color: "violet", time: "9:35 AM",
    headline: "Acme account summary updated",
    description: "Unifies customer context and recommends actions",
    tools: "CRM · Email · Meetings · Support history",
    actions: [
      { icon: "◎", title: "Customer Overview", description: "Get an AI summary of any account" },
      { icon: "◷", title: "Account Activity", description: "See messages, meetings and open work" },
      { icon: "✦", title: "Ask Customer AI", description: "Ask anything across customer history" },
    ],
  },
  {
    id: "followup", name: "Follow-up Agent", short: "F", color: "orange", time: "Yesterday", unread: 3,
    headline: "3 follow-ups need your approval",
    description: "Drafts and schedules personalized follow-ups",
    tools: "CRM · Email · Calendar · Engagement signals",
    actions: [
      { icon: "✓", title: "Follow-up Queue", description: "Review AI-prepared outreach" },
      { icon: "↗", title: "Create Sequence", description: "Build a personalized follow-up plan" },
      { icon: "✦", title: "Chat to AI", description: "Ask who to contact and what to say" },
    ],
  },
  {
    id: "insights", name: "Sales Insights Agent", short: "S", color: "rose", time: "Monday",
    headline: "Your morning sales brief is ready",
    description: "Explains performance, pipeline and risks",
    tools: "CRM · Revenue data · Activity analytics",
    actions: [
      { icon: "☀", title: "Daily Briefing", description: "Priorities, risks and opportunities today" },
      { icon: "▥", title: "Pipeline Report", description: "Conversational pipeline analysis" },
      { icon: "✦", title: "Ask Sales Data", description: "Get answers without building reports" },
    ],
  },
];

export default function Home() {
  const [view, setView] = useState<View>("agents");
  const [selectedId, setSelectedId] = useState<AgentId>("quotation");
  const [actionIndex, setActionIndex] = useState(0);
  const [dark, setDark] = useState(false);
  const [message, setMessage] = useState("");
  const [sentMessage, setSentMessage] = useState("");
  const selected = agents.find((agent) => agent.id === selectedId) ?? agents[0];
  const isChat = view === "chat";

  const openAgent = (id: AgentId) => { setSelectedId(id); setView("menu"); setSentMessage(""); };
  const openAction = (index: number) => { setActionIndex(index); setView("chat"); setSentMessage(""); };
  const send = (text = message) => { if (!text.trim()) return; setSentMessage(text.trim()); setMessage(""); };
  const goBack = () => { if (view === "chat") setView("menu"); else setView("agents"); };
  const goRoot = (next: View) => { setView(next); setSentMessage(""); };
  const title = view === "agents" ? "Sales OS" : view === "menu" ? selected.name.replace(" Agent", "") : view === "chat" ? selected.actions[actionIndex].title : view[0].toUpperCase() + view.slice(1);

  return (
    <main className={dark ? "stage dark" : "stage"}>
      <section className="phone sales-os" aria-label="AI-assisted conversational Sales OS prototype">
        <div className="status-bar"><span>9:41</span><span>▮▮▮ ᯤ ◉</span></div>
        <header className="topbar">
          <div className="title-group">
            {view !== "agents" && view !== "tasks" && view !== "approvals" && view !== "library" && <button className="back" onClick={goBack} aria-label="Go back">‹</button>}
            <div>{view === "agents" && <small>AI-assisted workspace</small>}<h1>{title}</h1></div>
          </div>
          <div className="header-buttons"><button className="demo-badge">DEMO</button><button className="icon-button" onClick={() => setDark(!dark)} aria-label="Toggle theme">{dark ? "☀" : "☾"}</button></div>
        </header>

        <div className={isChat ? "content chat-content" : "content"}>
          {view === "agents" && <AgentInbox onOpen={openAgent} />}
          {view === "menu" && <AgentMenu agent={selected} onOpen={openAction} />}
          {view === "chat" && <AgentConversation agent={selected} actionIndex={actionIndex} sentMessage={sentMessage} onPrompt={send} />}
          {view === "tasks" && <TasksScreen />}
          {view === "approvals" && <ApprovalsScreen />}
          {view === "library" && <LibraryScreen />}
        </div>

        {isChat && <div className="composer-wrap"><button className="attach" aria-label="Attach file">＋</button><input value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => event.key === "Enter" && send()} placeholder="Message your AI agent…" /><button className="send" onClick={() => send()} aria-label="Send">➤</button></div>}
        {!isChat && <nav className="bottom-nav">
          <button className={view === "agents" || view === "menu" ? "active" : ""} onClick={() => goRoot("agents")}><span>⌂</span><small>Agents</small></button>
          <button className={view === "tasks" ? "active" : ""} onClick={() => goRoot("tasks")}><span>◷</span><small>Tasks</small></button>
          <button className={view === "approvals" ? "active" : ""} onClick={() => goRoot("approvals")}><span>✓</span><small>Approvals</small><i>3</i></button>
          <button className={view === "library" ? "active" : ""} onClick={() => goRoot("library")}><span>▣</span><small>Library</small></button>
        </nav>}
        <div className="home-indicator" />
      </section>
    </main>
  );
}

function AgentInbox({ onOpen }: { onOpen: (id: AgentId) => void }) {
  return <>
    <div className="briefing-banner"><span>✦</span><div><strong>Good morning, Alex</strong><p>3 items need your attention. Your agents completed 11 tasks overnight.</p></div><button>View brief</button></div>
    <label className="search"><span>⌕</span><input placeholder="Search agents, customers and work" /></label>
    <div className="section-label"><span>Your AI sales team</span><small>5 agents online</small></div>
    <div className="agent-inbox">{agents.map((agent) => <button className="agent-row" key={agent.id} onClick={() => onOpen(agent.id)}>
      <span className={`agent-avatar ${agent.color}`}>{agent.short}<i /></span>
      <span className="row-copy"><strong>{agent.name}</strong><small>{agent.headline}</small></span>
      <span className="row-meta"><time>{agent.time}</time>{agent.unread && <b>{agent.unread}</b>}</span>
    </button>)}</div>
    <div className="automation-summary"><div><span>18</span><small>AI tasks this week</small></div><div><span>6.4h</span><small>Estimated time saved</small></div><div><span>92%</span><small>Accepted outputs</small></div></div>
  </>;
}

function AgentMenu({ agent, onOpen }: { agent: Agent; onOpen: (index: number) => void }) {
  return <>
    <div className={`agent-hero hero-${agent.color}`}><span className={`agent-avatar ${agent.color} large`}>{agent.short}<i /></span><div><h2>{agent.name}</h2><p>{agent.description}</p></div></div>
    <div className="section-label"><span>What would you like to do?</span></div>
    <div className="submenu">{agent.actions.map((action, index) => <button key={action.title} onClick={() => onOpen(index)}><span className={`menu-icon accent-${index}`}>{action.icon}</span><span className="row-copy"><strong>{action.title}</strong><small>{action.description}</small></span><span className="chevron">›</span></button>)}</div>
    <div className="agent-status"><span className="pulse" /><div><strong>Agent is ready</strong><small>Connected to {agent.tools}</small></div><span className="scope-pill">Copilot</span></div>
    <div className="trust-note"><strong>Human approval is on</strong><p>This agent can prepare work but asks before sending or changing customer records.</p></div>
  </>;
}

function AgentConversation({ agent, actionIndex, sentMessage, onPrompt }: { agent: Agent; actionIndex: number; sentMessage: string; onPrompt: (text: string) => void }) {
  const action = agent.actions[actionIndex];
  return <div className="conversation">
    <div className="agent-strip"><span className={`agent-avatar ${agent.color}`}>{agent.short}<i /></span><div><strong>{agent.name}</strong><small><span /> Online · {action.title}</small></div><button>⋮</button></div>
    <div className="day-pill">Today</div>
    <div className="bubble agent-bubble"><span className="mini-agent">✦</span><div><p>{introFor(agent.id, actionIndex)}</p><time>9:41 AM</time></div></div>
    {!sentMessage && <div className="quick-actions"><small>QUICK START</small>{promptsFor(agent.id, actionIndex).map((prompt) => <button key={prompt} onClick={() => onPrompt(prompt)}>{prompt}</button>)}</div>}
    {sentMessage && <><div className="bubble user-bubble"><p>{sentMessage}</p><time>9:42 AM ✓✓</time></div><ConversationResult agentId={agent.id} actionIndex={actionIndex} /></>}
  </div>;
}

function ConversationResult({ agentId, actionIndex }: { agentId: AgentId; actionIndex: number }) {
  if (agentId === "quotation") return <div className="bubble agent-bubble"><span className="mini-agent">✦</span><div><p>I found <strong>Acme Industries</strong> in CRM and matched its agreed pricing. Please confirm the details I prepared.</p><div className="rich-card form-card"><div className="card-title"><span>▤</span><div><strong>New quotation</strong><small>Draft · QT-1049</small></div></div><label>Customer<strong>Acme Industries</strong></label><label>Product<strong>Pro Plan — Annual</strong></label><div className="two-col"><label>Quantity<strong>20 seats</strong></label><label>Discount<strong>5%</strong></label></div><div className="total"><span>Estimated total</span><strong>RM 24,800</strong></div><button>Preview quotation</button></div><time>9:42 AM</time></div></div>;
  if (agentId === "prospecting") return <div className="bubble agent-bubble"><span className="mini-agent">✦</span><div><p>I searched for Malaysian retail companies matching your best customers. Here’s the strongest lead.</p><div className="rich-card lead-card"><div className="card-title"><span className="company-logo">NR</span><div><strong>Nova Retail Sdn Bhd</strong><small>Kuala Lumpur · Retail technology</small></div><b>87</b></div><div className="signal">● High intent signal: expanding to 14 outlets</div><p>Likely need: inventory and customer analytics. Estimated deal value: <strong>RM 42k</strong>.</p><div className="card-actions"><button>Save to CRM</button><button>Draft outreach</button></div></div><time>9:42 AM</time></div></div>;
  if (agentId === "customer") return <div className="bubble agent-bubble"><span className="mini-agent">✦</span><div><p>Here is the latest account brief based on CRM, email, meetings and support history.</p><div className="rich-card customer-card"><div className="card-title"><span className="company-logo">AC</span><div><strong>Acme Industries</strong><small>Strategic account · RM 186k ARR</small></div><span className="health">Healthy</span></div><div className="customer-grid"><div><small>Last contact</small><strong>2 days ago</strong></div><div><small>Open opportunity</small><strong>RM 24.8k</strong></div></div><h4>AI recommendation</h4><p>Confirm delivery timeline before Friday. The buyer opened your proposal three times today.</p><button>Prepare follow-up</button></div><time>9:42 AM</time></div></div>;
  if (agentId === "followup") return <div className="bubble agent-bubble"><span className="mini-agent">✦</span><div><p>I prepared a personalized follow-up using the opportunity and recent meeting context.</p><div className="rich-card followup-card"><div className="approval-head"><span>Approval required</span><small>Email · Acme Industries</small></div><p><strong>Subject:</strong> Delivery timeline for your Pro Plan rollout</p><blockquote>Hi Jane, following our discussion, I’ve confirmed that we can support your preferred rollout window…</blockquote><div className="card-actions"><button className="secondary">Edit</button><button>Approve & schedule</button></div></div><time>9:42 AM</time></div></div>;
  return <div className="bubble agent-bubble"><span className="mini-agent">✦</span><div><p>I analyzed your current pipeline and today’s activities. Here is the key picture.</p><div className="rich-card insight-report"><div className="card-title"><span>▥</span><div><strong>Pipeline today</strong><small>Updated 2 minutes ago</small></div></div><div className="pipeline-total"><strong>RM 1.24M</strong><small>Weighted pipeline · +8.2%</small></div><div className="bars"><i style={{height:"36%"}}/><i style={{height:"54%"}}/><i style={{height:"42%"}}/><i style={{height:"75%"}}/><i style={{height:"65%"}}/><i style={{height:"88%"}}/><i style={{height:"72%"}}/></div><div className="risk"><strong>⚠ 2 deals need attention</strong><small>RM 96k may slip without action this week.</small></div><button>Show at-risk deals</button></div><time>9:42 AM</time></div></div>;
}

function TasksScreen() { return <><div className="summary-grid"><div><strong>6</strong><small>In progress</small></div><div><strong>11</strong><small>Completed today</small></div><div><strong>2</strong><small>Blocked</small></div></div><div className="section-label"><span>Agent activity</span><small>Live</small></div><div className="work-list"><Work icon="Q" color="emerald" title="Generating QT-1049" detail="Quotation Agent · 74% complete" progress={74}/><Work icon="P" color="blue" title="Enriching 12 leads" detail="Prospecting Agent · Running" progress={46}/><Work icon="S" color="rose" title="Analyzing Q3 pipeline" detail="Insights Agent · Waiting for CRM" progress={28}/><Work icon="F" color="orange" title="Follow-up sequence" detail="Paused · Needs your input" progress={58}/></div></>; }
function Work({icon,color,title,detail,progress}:{icon:string;color:string;title:string;detail:string;progress:number}) { return <div className="work-item"><span className={`agent-avatar tiny ${color}`}>{icon}</span><div><strong>{title}</strong><small>{detail}</small><i><b style={{width:`${progress}%`}}/></i></div><span>›</span></div>; }

function ApprovalsScreen() { return <><div className="approval-intro"><span>✓</span><div><strong>3 decisions waiting</strong><p>Your agents will continue automatically after approval.</p></div></div><div className="approval-list"><div className="approval-item"><div><span className="agent-avatar tiny emerald">Q</span><small>Quotation Agent</small><time>8 min</time></div><h3>Approve quotation QT-1048?</h3><p>Acme Industries · RM 24,800 · 5% discount</p><div><button className="secondary">Review</button><button>Approve</button></div></div><div className="approval-item"><div><span className="agent-avatar tiny orange">F</span><small>Follow-up Agent</small><time>21 min</time></div><h3>Schedule 2 customer emails?</h3><p>Personalized from recent meeting notes</p><div><button className="secondary">Review</button><button>Approve</button></div></div></div></>; }

function LibraryScreen() { return <><label className="search"><span>⌕</span><input placeholder="Search generated sales work" /></label><div className="section-label"><span>Recent artifacts</span><small>View all</small></div><div className="library-grid"><Artifact icon="▤" title="QT-1048" detail="Quotation · Acme" tone="mint"/><Artifact icon="▥" title="Q3 Pipeline" detail="Report · Today" tone="blue"/><Artifact icon="✉" title="Acme follow-up" detail="Email · Draft" tone="amber"/><Artifact icon="♙" title="Retail leads" detail="Lead list · 12 records" tone="purple"/></div></>; }
function Artifact({icon,title,detail,tone}:{icon:string;title:string;detail:string;tone:string}) { return <button className="artifact"><span className={tone}>{icon}</span><strong>{title}</strong><small>{detail}</small></button>; }

function introFor(id: AgentId, action: number) {
  const copy: Record<AgentId, string[]> = {
    quotation: ["Tell me who the quotation is for and what they need. I’ll check customer terms, pricing and product rules, then prepare a draft for approval.", "I can find any quotation and explain its status, value or next action.", "Ask me anything about products, discounts, customer terms or quotation policy."],
    prospecting: ["Describe your ideal customer. I’ll research, qualify and rank matching leads for you.", "I can filter your lead list and explain why each prospect is worth contacting.", "Ask me to research a company, market, buyer or sales signal."],
    customer: ["Name a customer and I’ll build a complete account brief across your sales systems.", "I can summarize every recent interaction, open task and opportunity for an account.", "Ask anything about a customer. I’ll search their full business history."],
    followup: ["I’ve prioritized the customers who need attention and prepared contextual follow-ups for approval.", "Tell me the goal and audience. I’ll prepare a personalized contact sequence.", "Ask who you should follow up with, when, and what to say."],
    insights: ["I’ve analyzed your pipeline and activity. Ask for today’s priorities or open your morning brief.", "Ask about pipeline value, movement, risk, forecast or salesperson performance.", "Ask a sales question in plain language—no report builder needed."],
  };
  return copy[id][action];
}

function promptsFor(id: AgentId, action: number) {
  const primary: Record<AgentId, string[]> = {
    quotation: ["Create a quotation for Acme Industries", "Quote 20 seats of Pro Plan", "Use my latest customer enquiry"],
    prospecting: ["Find retail companies expanding in Malaysia", "Show leads similar to Acme", "Find 10 decision-makers for Pro Plan"],
    customer: ["Brief me on Acme Industries", "What changed since my last Acme meeting?", "Show accounts with renewal risk"],
    followup: ["Show follow-ups that need approval", "Prepare a follow-up for Acme", "Who should I contact today?"],
    insights: ["Give me my morning sales brief", "Why did pipeline change this week?", "Which deals are most likely to slip?"],
  };
  return action === 0 ? primary[id] : primary[id].slice().reverse();
}
