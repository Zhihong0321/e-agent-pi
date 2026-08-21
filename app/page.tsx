"use client";

import { useState } from "react";

type Screen = "home" | "quotation" | "new" | "mine" | "ai";

const quotationMenu = [
  { id: "new" as const, icon: "+", title: "New Quotation", description: "Create a quotation with an AI agent", accent: "mint" },
  { id: "mine" as const, icon: "▤", title: "Your Quotations", description: "View drafts, approvals and sent quotations", accent: "blue" },
  { id: "ai" as const, icon: "✦", title: "Chat to AI", description: "Ask about pricing, customers or quotation rules", accent: "purple" },
];

const quotations = [
  { id: "QT-1048", customer: "Acme Industries", amount: "RM 24,800", status: "Awaiting approval", tone: "amber" },
  { id: "QT-1047", customer: "Northstar Retail", amount: "RM 8,450", status: "Draft", tone: "gray" },
  { id: "QT-1046", customer: "Orbit Systems", amount: "RM 17,200", status: "Sent", tone: "green" },
];

export default function Home() {
  const [screen, setScreen] = useState<Screen>("home");
  const [dark, setDark] = useState(false);
  const [message, setMessage] = useState("");
  const [request, setRequest] = useState("");

  const goBack = () => {
    if (screen === "quotation") setScreen("home");
    else if (screen !== "home") setScreen("quotation");
  };

  const startRequest = (text: string) => {
    setRequest(text);
    setMessage("");
  };

  const title = screen === "home" ? "AI Workforce" : screen === "quotation" ? "Quotation" : screen === "new" ? "New Quotation" : screen === "mine" ? "Your Quotations" : "Quotation AI";

  return (
    <main className={dark ? "stage dark" : "stage"}>
      <section className="phone" aria-label="AI automation mobile application">
        <div className="status-bar"><span>9:41</span><span>▮▮▮ ᯤ ◉</span></div>
        <header className="topbar">
          <div className="title-group">
            {screen !== "home" && <button className="back" onClick={goBack} aria-label="Go back">‹</button>}
            <div>{screen === "home" && <small>Good morning, Alex</small>}<h1>{title}</h1></div>
          </div>
          <button className="icon-button" onClick={() => setDark(!dark)} aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}>{dark ? "☀" : "☾"}</button>
        </header>

        <div className={screen === "new" || screen === "ai" ? "content chat-content" : "content"}>
          {screen === "home" && <HomeScreen onOpen={() => setScreen("quotation")} />}
          {screen === "quotation" && <QuotationMenu onOpen={setScreen} />}
          {screen === "mine" && <QuotationList />}
          {screen === "new" && <AgentChat request={request} onStart={startRequest} />}
          {screen === "ai" && <GeneralChat request={request} />}
        </div>

        {(screen === "new" || screen === "ai") && <div className="composer-wrap">
          <button className="attach" aria-label="Attach file">＋</button>
          <input value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && message.trim()) startRequest(message.trim()); }} placeholder={screen === "new" ? "Describe the quotation…" : "Ask Quotation AI…"} />
          <button className="send" onClick={() => message.trim() && startRequest(message.trim())} aria-label="Send message">➤</button>
        </div>}

        {screen !== "new" && screen !== "ai" && <nav className="bottom-nav">
          <button className="active"><span>⌂</span><small>Agents</small></button><button><span>◷</span><small>Tasks</small></button><button><span>✓</span><small>Approvals</small></button><button><span>▣</span><small>Library</small></button>
        </nav>}
        <div className="home-indicator" />
      </section>
    </main>
  );
}

function HomeScreen({ onOpen }: { onOpen: () => void }) {
  return <>
    <label className="search"><span>⌕</span><input placeholder="Search agents and work" /></label>
    <div className="section-label"><span>Your agents</span><small>1 active</small></div>
    <button className="agent-row" onClick={onOpen}>
      <span className="agent-avatar quote-avatar">Q<i /></span>
      <span className="row-copy"><strong>Quotation</strong><small>QT-1048 is ready for approval</small></span>
      <span className="row-meta"><time>11:42 AM</time><b>2</b></span>
    </button>
    <div className="insight-card"><span className="spark">✦</span><div><strong>Your AI workforce is active</strong><p>Quotation Agent completed 4 tasks this week and saved approximately 1.8 hours.</p></div></div>
    <div className="section-label"><span>Recent activity</span></div>
    <div className="activity"><span className="activity-icon">✓</span><div><strong>Quotation sent</strong><small>QT-1046 · Orbit Systems</small></div><time>Yesterday</time></div>
  </>;
}

function QuotationMenu({ onOpen }: { onOpen: (screen: Screen) => void }) {
  return <>
    <div className="agent-hero"><span className="agent-avatar quote-avatar large">Q<i /></span><div><h2>Quotation Agent</h2><p>Your AI specialist for creating, reviewing and managing quotations.</p></div></div>
    <div className="section-label"><span>What would you like to do?</span></div>
    <div className="submenu">{quotationMenu.map((item) => <button key={item.id} onClick={() => onOpen(item.id)}>
      <span className={`menu-icon ${item.accent}`}>{item.icon}</span><span className="row-copy"><strong>{item.title}</strong><small>{item.description}</small></span><span className="chevron">›</span>
    </button>)}</div>
    <div className="agent-status"><span className="pulse" /><div><strong>Agent is online</strong><small>Connected to CRM, product catalogue and pricing rules</small></div></div>
  </>;
}

function QuotationList() {
  return <>
    <div className="summary-grid"><div><strong>12</strong><small>This month</small></div><div><strong>RM 86k</strong><small>Total value</small></div><div><strong>3</strong><small>Need action</small></div></div>
    <label className="search compact"><span>⌕</span><input placeholder="Search quotations" /></label>
    <div className="filter-row"><button className="selected">All</button><button>Drafts</button><button>Approval</button><button>Sent</button></div>
    <div className="quotation-list">{quotations.map((quote) => <button key={quote.id}>
      <span className="doc-icon">▤</span><span className="row-copy"><strong>{quote.customer}</strong><small>{quote.id} · {quote.amount}</small></span><span className={`status ${quote.tone}`}>{quote.status}</span>
    </button>)}</div>
  </>;
}

function AgentChat({ request, onStart }: { request: string; onStart: (text: string) => void }) {
  return <div className="conversation">
    <div className="agent-strip"><span className="agent-avatar quote-avatar">Q<i /></span><div><strong>New Quotation Agent</strong><small><span /> Online · Quotation specialist</small></div></div>
    <div className="day-pill">Today</div>
    <div className="bubble agent-bubble"><span className="mini-agent">✦</span><div><p>Hi Alex! I’ll help you create a complete quotation.</p><p>Tell me the customer and what they need. I’ll check your CRM, product pricing and company rules.</p><time>9:41 AM</time></div></div>
    {!request && <div className="quick-actions"><small>TRY SAYING</small><button onClick={() => onStart("Create a quotation for Acme Industries")}>Create a quote for Acme Industries</button><button onClick={() => onStart("Quote 20 units of Pro Plan")}>Quote 20 units of Pro Plan</button><button onClick={() => onStart("Use my latest customer enquiry")}>Use my latest customer enquiry</button></div>}
    {request && <>
      <div className="bubble user-bubble"><p>{request}</p><time>9:42 AM ✓✓</time></div>
      <div className="bubble agent-bubble"><span className="mini-agent">✦</span><div><p>I found <strong>Acme Industries</strong> in your CRM. I’ve prefilled their billing details and payment terms.</p><p>Please confirm the quotation details:</p><div className="inline-form"><label>Customer<strong>Acme Industries</strong></label><label>Product<strong>Pro Plan</strong></label><div><label>Quantity<strong>20</strong></label><label>Discount<strong>5%</strong></label></div><button>Continue to preview</button></div><time>9:42 AM</time></div></div>
    </>}
  </div>;
}

function GeneralChat({ request }: { request: string }) {
  return <div className="conversation"><div className="agent-strip"><span className="agent-avatar ai-avatar">AI<i /></span><div><strong>Quotation AI</strong><small><span /> Online · Ask anything</small></div></div><div className="day-pill">Today</div><div className="bubble agent-bubble"><span className="mini-agent">✦</span><div><p>Ask me about customers, prices, discounts, quotation status or company policies.</p><time>9:41 AM</time></div></div>{request && <><div className="bubble user-bubble"><p>{request}</p><time>9:42 AM ✓✓</time></div><div className="bubble agent-bubble"><span className="mini-agent">✦</span><div><p>I’m checking your quotation records and company knowledge now.</p><time>9:42 AM</time></div></div></>}</div>;
}
