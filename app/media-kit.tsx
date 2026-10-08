import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from "react";
import "./media-kit.css";

type Category = "all" | "logo" | "event_photo" | "news" | "certification" | "qualification" | "award";
type Visibility = "draft" | "published" | "archived";

type Asset = {
  id: string;
  category: Exclude<Category, "all">;
  title: string;
  description: string;
  altText: string;
  language: string;
  assetDate: string | null;
  issuer: string;
  sourceUrl: string;
  credential: string;
  file: { id: string; name: string; bytes: number; mime: string; url: string; link: string };
  visibility: Visibility;
  sortOrder: number;
  metadata: Record<string, unknown>;
  revision: number;
};

type Company = {
  name?: string;
  legal_name?: string;
  website?: string;
  email?: string;
  phone?: string;
  logo_url?: string;
  address?: Record<string, string> | string;
};

type ProfileResponse = { company: Company };
type Manifest = { company: { name: string; legalName: string; website: string; email: string; phone: string; logoUrl: string; address: Record<string, string> | string }; assets: Asset[]; generatedAt: string };
type Share = { id: string; label: string; expiresAt: string | null; revokedAt: string | null; createdAt: string };

type ApiError = { error?: string };

const CATEGORIES: Array<{ id: Category; label: string; icon: string }> = [
  { id: "all", label: "All assets", icon: "✦" },
  { id: "logo", label: "Logos", icon: "◈" },
  { id: "event_photo", label: "Events", icon: "◉" },
  { id: "news", label: "News", icon: "▤" },
  { id: "certification", label: "Certifications", icon: "✓" },
  { id: "qualification", label: "Qualifications", icon: "◇" },
  { id: "award", label: "Awards", icon: "★" },
];

function labelFor(category: Category) {
  return CATEGORIES.find((item) => item.id === category)?.label ?? category;
}

function isImage(asset: Asset) {
  return asset.file.mime.startsWith("image/");
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "include", ...init, headers: { "Content-Type": "application/json", ...(init?.headers || {}) } });
  const body = (await response.json().catch(() => ({}))) as T & ApiError;
  if (!response.ok) throw new Error(body.error || (response.status === 401 ? "Please unlock Media Kit first." : "Request failed"));
  return body;
}

function fileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read that file"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

function AssetCard({ asset, readOnly, onPublish, onArchive }: { asset: Asset; readOnly: boolean; onPublish?: () => void; onArchive?: () => void }) {
  return (
    <article className="mk-asset-card">
      <div className="mk-asset-visual">
        {isImage(asset) ? <img src={asset.file.url} alt={asset.altText || asset.title} loading="lazy" /> : <div className="mk-doc-icon"><span>PDF</span><small>{formatBytes(asset.file.bytes)}</small></div>}
        <span className={`mk-visibility ${asset.visibility}`}>{asset.visibility}</span>
      </div>
      <div className="mk-asset-body">
        <div className="mk-asset-kicker"><span>{labelFor(asset.category)}</span>{asset.assetDate ? <time>{asset.assetDate}</time> : null}</div>
        <h3>{asset.title}</h3>
        {asset.description ? <p>{asset.description}</p> : null}
        <div className="mk-asset-meta">
          {asset.issuer ? <span>{asset.issuer}</span> : null}
          {asset.credential ? <span>{asset.credential}</span> : null}
          <a href={asset.file.url} target="_blank" rel="noreferrer">Open file ↗</a>
        </div>
        {!readOnly ? (
          <div className="mk-card-actions">
            {asset.visibility === "draft" ? <button type="button" onClick={onPublish}>Publish</button> : null}
            {asset.visibility !== "archived" ? <button type="button" className="muted" onClick={onArchive}>Archive</button> : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function Login({ onLogin }: { onLogin: () => Promise<void> }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    setBusy(true); setError("");
    try { await onLoginWithPassword(password); await onLogin(); }
    catch (err) { setError(err instanceof Error ? err.message : "Unlock failed"); }
    finally { setBusy(false); }
  };
  return (
    <main className="mk-auth-shell">
      <section className="mk-auth-card">
        <div className="mk-mark">MK</div>
        <p className="mk-eyebrow">COMPANY MEDIA KIT</p>
        <h1>Keep every story asset ready to share.</h1>
        <p className="mk-auth-copy">Unlock the private Media Kit workspace to curate logos, events, news, certifications and awards for your next partner conversation.</p>
        <label className="mk-field">Access password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void submit(); }} /></label>
        {error ? <p className="mk-error" role="alert">{error}</p> : null}
        <button className="mk-primary" type="button" disabled={busy || !password} onClick={() => void submit()}>{busy ? "Unlocking…" : "Unlock Media Kit"}</button>
        <a className="mk-back-link" href="/">← Back to Studio</a>
      </section>
    </main>
  );
}

async function onLoginWithPassword(password: string) {
  const response = await fetch("/api/auth/login", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
  const body = (await response.json().catch(() => ({}))) as ApiError;
  if (!response.ok) throw new Error(body.error || "Unlock failed");
}

export function MediaKitView({ readOnly = false, token, embedded = false }: { readOnly?: boolean; token?: string; embedded?: boolean }) {
  const [company, setCompany] = useState<Company>({});
  const [assets, setAssets] = useState<Asset[]>([]);
  const [shares, setShares] = useState<Share[]>([]);
  const [category, setCategory] = useState<Category>("all");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [showUpload, setShowUpload] = useState(false);
  const [shareUrl, setShareUrl] = useState("");
  const [upload, setUpload] = useState({ file: null as File | null, title: "", category: "event_photo" as Exclude<Category, "all">, description: "", altText: "", assetDate: "", issuer: "", credential: "", visibility: "draft" as Visibility });

  const load = useCallback(async () => {
    setBusy(true); setError("");
    try {
      if (readOnly && token) {
        const data = await json<Manifest>(`/api/media-kit/share/${encodeURIComponent(token)}`);
        setCompany({ name: data.company.name, legal_name: data.company.legalName, website: data.company.website, email: data.company.email, phone: data.company.phone, logo_url: data.company.logoUrl, address: data.company.address });
        setAssets(data.assets);
      } else {
        const [profile, rows, shareRows] = await Promise.all([
          json<ProfileResponse>("/api/media-kit/profile"),
          json<Asset[]>("/api/media-kit?visibility=all"),
          json<Share[]>("/api/media-kit/shares"),
        ]);
        setCompany(profile.company); setAssets(rows); setShares(shareRows);
      }
    } catch (err) { setError(err instanceof Error ? err.message : "Could not load Media Kit"); }
    finally { setBusy(false); }
  }, [readOnly, token]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- load synchronizes the view with the authenticated host API.
  useEffect(() => { void load(); }, [load]);

  const visibleAssets = useMemo(() => assets.filter((asset) => (category === "all" || asset.category === category) && `${asset.title} ${asset.description} ${asset.issuer}`.toLowerCase().includes(query.toLowerCase())), [assets, category, query]);
  const counts = useMemo(() => Object.fromEntries(CATEGORIES.map((item) => [item.id, item.id === "all" ? assets.length : assets.filter((asset) => asset.category === item.id).length])), [assets]);

  const updateAsset = async (asset: Asset, patch: Record<string, unknown>) => {
    setBusy(true); setError("");
    try { await json(`/api/media-kit/assets/${asset.id}`, { method: "PATCH", body: JSON.stringify({ ...patch, revision: asset.revision }) }); setNotice(patch.visibility === "published" ? "Asset published to the partner-ready kit." : "Asset archived."); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not update asset"); }
    finally { setBusy(false); }
  };

  const submitUpload = async () => {
    if (!upload.file || !upload.title.trim()) { setError("Choose a file and add a title first."); return; }
    if (upload.file.size > 25 * 1024 * 1024) { setError("Media assets must be 25 MB or smaller."); return; }
    setBusy(true); setError("");
    try {
      const data = await fileAsDataUrl(upload.file);
      await json("/api/media-kit/upload", { method: "POST", body: JSON.stringify({ data, fileName: upload.file.name, title: upload.title, category: upload.category, description: upload.description, altText: upload.altText, assetDate: upload.assetDate || undefined, issuer: upload.issuer, credential: upload.credential, visibility: upload.visibility }) });
      setUpload({ file: null, title: "", category: "event_photo", description: "", altText: "", assetDate: "", issuer: "", credential: "", visibility: "draft" });
      setShowUpload(false); setNotice("Asset added to the Media Kit as a draft."); await load();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not upload asset"); }
    finally { setBusy(false); }
  };

  const createShare = async () => {
    setBusy(true); setError("");
    try { const result = await json<{ url: string }>("/api/media-kit/shares", { method: "POST", body: JSON.stringify({ label: "Advertiser Media Kit", expiresDays: 30 }) }); const full = new URL(result.url, window.location.origin).toString(); setShareUrl(full); await navigator.clipboard?.writeText(full).catch(() => {}); setNotice("A 30-day share link was created and copied."); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not create share link"); }
    finally { setBusy(false); }
  };

  const logout = async () => { await fetch("/api/auth/logout", { method: "POST", credentials: "include" }); window.location.reload(); };

  return (
    <main className={["mk-shell", embedded ? "mk-embedded" : ""].filter(Boolean).join(" ")}>
      {!embedded && <header className="mk-topbar"><a className="mk-brand" href="/"><span className="mk-brand-mark">MK</span><span><strong>Media Kit</strong><small>COMPANY STORY, READY TO SHARE</small></span></a><div className="mk-top-actions"><a href="/">Studio</a>{!readOnly ? <button type="button" onClick={() => void logout()}>Lock</button> : <span className="mk-share-pill">Read-only share</span>}</div></header>}
      <div className="mk-content">
        <section className="mk-hero">
          <div className="mk-hero-copy"><p className="mk-eyebrow">{readOnly ? "PARTNER MEDIA KIT" : "MEDIA AI · COMPANY LIBRARY"}</p><h1>{company.name || "Your company"}<br /><em>in the right frame.</em></h1><p className="mk-hero-text">{readOnly ? "A focused collection of approved brand assets, company news and proof points for the next collaboration." : "One organized home for the assets advertisers, event partners and social teams ask for most."}</p><div className="mk-hero-actions">{!readOnly ? <><button className="mk-primary" type="button" onClick={() => setShowUpload(true)}>＋ Add media</button><button className="mk-secondary" type="button" onClick={() => void createShare()} disabled={busy}>Create share link</button></> : <span className="mk-approved"><i /> Approved assets only</span>}</div></div><div className="mk-hero-card">{company.logo_url ? <img src={company.logo_url} alt={`${company.name || "Company"} logo`} /> : <div className="mk-logo-placeholder">{(company.name || "MK").slice(0, 2).toUpperCase()}</div>}<span>Brand library</span><strong>{assets.length} curated asset{assets.length === 1 ? "" : "s"}</strong><small>{readOnly ? "Shared with you" : "Owned by your company"}</small></div>
        </section>
        {shareUrl ? <div className="mk-share-banner"><span><strong>Share link ready</strong><small>{shareUrl}</small></span><button type="button" onClick={() => void navigator.clipboard?.writeText(shareUrl)}>Copy</button><a href={shareUrl} target="_blank" rel="noreferrer">Preview ↗</a></div> : null}
        {error ? <div className="mk-alert" role="alert">{error}<button type="button" onClick={() => setError("")}>×</button></div> : null}
        {notice ? <div className="mk-notice" role="status">{notice}</div> : null}
        <section className="mk-library-head"><div><p className="mk-eyebrow">THE LIBRARY</p><h2>Everything your next story needs.</h2></div><label className="mk-search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search assets" /></label></section>
        <nav className="mk-category-nav" aria-label="Media Kit categories">{CATEGORIES.map((item) => <button key={item.id} className={category === item.id ? "active" : ""} type="button" onClick={() => setCategory(item.id)}><span>{item.icon}</span>{item.label}<b>{counts[item.id] || 0}</b></button>)}</nav>
        {busy && !assets.length ? <div className="mk-empty"><strong>Loading your library…</strong><span>Media AI is gathering the latest approved collection.</span></div> : visibleAssets.length ? <div className="mk-assets-grid">{visibleAssets.map((asset) => <AssetCard key={asset.id} asset={asset} readOnly={readOnly} onPublish={() => void updateAsset(asset, { visibility: "published" })} onArchive={() => void updateAsset(asset, { visibility: "archived" })} />)}</div> : <div className="mk-empty"><div className="mk-empty-icon">✦</div><strong>{query || category !== "all" ? "No matching assets yet" : "Your story starts here"}</strong><span>{readOnly ? "The company has not published assets in this category." : "Add a logo, event photo, news item or proof point to build the collection."}</span>{!readOnly ? <button className="mk-primary" type="button" onClick={() => setShowUpload(true)}>Add the first asset</button> : null}</div>}
        {!readOnly && shares.length ? <section className="mk-shares"><div><p className="mk-eyebrow">CONTROLLED SHARING</p><h2>Partner links</h2></div>{shares.map((share) => <div className="mk-share-row" key={share.id}><span><strong>{share.label}</strong><small>{share.revokedAt ? "Revoked" : share.expiresAt ? `Expires ${new Date(share.expiresAt).toLocaleDateString()}` : "No expiry"}</small></span>{!share.revokedAt ? <button type="button" onClick={async () => { setBusy(true); try { await json(`/api/media-kit/shares/${share.id}`, { method: "POST" }); setNotice("Share link revoked."); await load(); } catch (err) { setError(err instanceof Error ? err.message : "Could not revoke link"); } finally { setBusy(false); } }}>Revoke</button> : null}</div>)}</section> : null}
      </div>
      {showUpload ? <div className="mk-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowUpload(false); }}><section className="mk-modal" role="dialog" aria-modal="true" aria-labelledby="mk-upload-title"><div className="mk-modal-head"><div><p className="mk-eyebrow">NEW ASSET</p><h2 id="mk-upload-title">Add to the library</h2></div><button type="button" onClick={() => setShowUpload(false)} aria-label="Close">×</button></div><label className="mk-field">File<input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,application/pdf" onChange={(event: ChangeEvent<HTMLInputElement>) => setUpload((old) => ({ ...old, file: event.target.files?.[0] || null }))} /></label><div className="mk-form-grid"><label className="mk-field">Title<input value={upload.title} onChange={(event) => setUpload((old) => ({ ...old, title: event.target.value }))} placeholder="Eternalgy at Solar Week" /></label><label className="mk-field">Category<select value={upload.category} onChange={(event) => setUpload((old) => ({ ...old, category: event.target.value as Exclude<Category, "all"> }))}>{CATEGORIES.filter((item) => item.id !== "all").map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}</select></label><label className="mk-field">Date<input type="date" value={upload.assetDate} onChange={(event) => setUpload((old) => ({ ...old, assetDate: event.target.value }))} /></label><label className="mk-field">Issuer / source<input value={upload.issuer} onChange={(event) => setUpload((old) => ({ ...old, issuer: event.target.value }))} placeholder="Awarding body" /></label></div><label className="mk-field">Description<textarea value={upload.description} onChange={(event) => setUpload((old) => ({ ...old, description: event.target.value }))} placeholder="What should a partner know about this asset?" /></label><label className="mk-field">Alt text<input value={upload.altText} onChange={(event) => setUpload((old) => ({ ...old, altText: event.target.value }))} placeholder="Describe the image for accessibility" /></label><div className="mk-modal-actions"><button type="button" className="mk-secondary" onClick={() => setShowUpload(false)}>Cancel</button><button type="button" className="mk-primary" disabled={busy} onClick={() => void submitUpload()}>{busy ? "Adding…" : "Add as draft"}</button></div></section></div> : null}
    </main>
  );
}

export default function MediaKitPage() {
  const shareMatch = window.location.pathname.match(/^\/media-kit\/share\/([^/]+)$/);
  const readOnly = Boolean(shareMatch);
  const [auth, setAuth] = useState<boolean | null>(readOnly ? true : null);
  const check = useCallback(async () => {
    if (readOnly) return;
    const [settingsResponse, demoResponse] = await Promise.all([
      fetch("/api/auth/me", { credentials: "include" }),
      fetch("/api/demo/me", { credentials: "include" }),
    ]);
    const settingsData = (await settingsResponse.json().catch(() => ({}))) as { ok?: boolean };
    const demoData = (await demoResponse.json().catch(() => ({}))) as { user?: unknown };
    setAuth(Boolean((settingsResponse.ok && settingsData.ok) || (demoResponse.ok && demoData.user)));
  }, [readOnly]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- check synchronizes the route with the existing auth cookie.
  useEffect(() => { void check(); }, [check]);
  if (auth === null) return <main className="mk-auth-shell"><p className="mk-loading">Checking access…</p></main>;
  if (!auth) return <Login onLogin={check} />;
  return <MediaKitView readOnly={readOnly} token={shareMatch ? decodeURIComponent(shareMatch[1]) : undefined} />;
}
