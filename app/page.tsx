"use client";

import { useState } from "react";

type Tab = "chats" | "updates" | "calls" | "communities";

const chats = [
  { name: "Arianna Lewis", message: "Sure, see you at 7!", time: "11:42 AM", unread: 2, color: "#8b5cf6", initials: "AL", online: true },
  { name: "Design Squad", message: "Mika: The latest mockups are in ✨", time: "10:18 AM", unread: 5, color: "#f59e0b", initials: "DS", online: false },
  { name: "Jordan Kim", message: "Voice message", time: "9:47 AM", unread: 0, color: "#0ea5e9", initials: "JK", online: true, voice: true },
  { name: "Weekend Plans", message: "Sam: I found the perfect spot!", time: "Yesterday", unread: 0, color: "#ec4899", initials: "WP", online: false },
  { name: "Nora Patel", message: "Photo", time: "Yesterday", unread: 0, color: "#14b8a6", initials: "NP", online: false, photo: true },
  { name: "Family", message: "Dad: Love you all ❤️", time: "Monday", unread: 0, color: "#f97316", initials: "FA", online: false },
];

const tabInfo: Record<Tab, { label: string; icon: string; title: string }> = {
  chats: { label: "Chats", icon: "▣", title: "Chats" },
  updates: { label: "Updates", icon: "◉", title: "Updates" },
  communities: { label: "Communities", icon: "♧", title: "Communities" },
  calls: { label: "Calls", icon: "☎", title: "Calls" },
};

export default function Home() {
  const [tab, setTab] = useState<Tab>("chats");
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [dark, setDark] = useState(false);
  const visibleChats = chats.filter((chat) => `${chat.name} ${chat.message}`.toLowerCase().includes(query.toLowerCase()));

  return (
    <main className={dark ? "stage dark" : "stage"}>
      <section className="phone" aria-label="WhatsApp inspired mobile chat template">
        <div className="status-bar"><span>9:41</span><span className="status-icons">▮▮▮ ᯤ ◉</span></div>
        <header className="topbar">
          <h1>{tabInfo[tab].title}</h1>
          <div className="header-actions"><button className="icon-button theme-button" aria-label={dark ? "Switch to light mode" : "Switch to dark mode"} onClick={() => setDark(!dark)}>{dark ? "☀" : "☾"}</button><button className="icon-button" aria-label="Camera">⌾</button><button className="icon-button" aria-label="More options" onClick={() => setMenuOpen(!menuOpen)}>⋮</button></div>
          {menuOpen && <div className="menu"><button>New group</button><button>Linked devices</button><button>Settings</button></div>}
        </header>
        <div className="content">
          {tab === "chats" && <>
            <label className="search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" aria-label="Search chats" /></label>
            <div className="filter-row"><button className="filter selected">All</button><button className="filter">Unread</button><button className="filter">Favorites</button><button className="filter">Groups</button></div>
            <div className="archive"><span className="archive-icon">⌑</span><span>Archived</span><span className="archive-count">3</span></div>
            <div className="chat-list">{visibleChats.map((chat) => <button className="chat" key={chat.name}>
              <span className="avatar" style={{ background: chat.color }}>{chat.initials}{chat.online && <i />}</span>
              <span className="chat-body"><span className="chat-name">{chat.name}</span><span className="chat-message">{chat.voice ? "▸  0:12" : chat.photo ? "▧  Photo" : chat.message}</span></span>
              <span className="chat-meta"><span className={chat.unread ? "active-time" : ""}>{chat.time}</span>{chat.unread > 0 && <b>{chat.unread}</b>}</span>
            </button>)}</div>
          </>}
          {tab === "updates" && <div className="empty-state"><div className="large-avatar gradient">ME</div><h2>Status</h2><p>Share photos, videos and messages that disappear after 24 hours.</p><button className="primary">Add status</button><h3>Recent updates</h3><div className="update-row"><span className="avatar" style={{background:"#8b5cf6"}}>AL</span><span><strong>Arianna Lewis</strong><small>Today, 10:15 AM</small></span></div></div>}
          {tab === "communities" && <div className="empty-state"><div className="community-mark">♧</div><h2>Stay connected with communities</h2><p>Organize related groups and get updates in one place.</p><button className="primary">Start a community</button></div>}
          {tab === "calls" && <div className="empty-state calls"><div className="large-avatar call-avatar">☎</div><h2>Calls</h2><p>Start a call with your friends and family.</p><button className="primary">New call</button><h3>Recent</h3><div className="update-row"><span className="avatar" style={{background:"#0ea5e9"}}>JK</span><span><strong>Jordan Kim</strong><small>↗ Outgoing · Yesterday</small></span><em>☎</em></div></div>}
        </div>
        <button className="fab" aria-label={tab === "calls" ? "Start a new call" : "Start a new chat"}>{tab === "calls" ? "☎" : "✎"}</button>
        <nav className="bottom-nav" aria-label="Main navigation">{(Object.keys(tabInfo) as Tab[]).map((item) => <button key={item} onClick={() => setTab(item)} className={tab === item ? "nav-item active" : "nav-item"}><span>{tabInfo[item].icon}</span><small>{tabInfo[item].label}</small></button>)}</nav>
        <div className="home-indicator" />
      </section>
    </main>
  );
}
