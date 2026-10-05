import { dbReady } from "./db.mjs";
import { listSites } from "./sites.mjs";
import {
  capabilities,
  authStatus,
  clickAt,
  clickRef,
  closeSession,
  closeTab,
  ensureSession,
  holdLease,
  listTabs,
  navigate,
  newTab,
  pressKey,
  screenshotJpeg,
  sessionStatus,
  snapshot,
  switchTab,
  typeRef,
  waitFor,
  SHARED_PROFILE_SLUG,
  wantsHeadedLogin,
} from "./browser-session.mjs";
import {
  deleteSignin,
  ensureBrowserSchema,
  getSignin,
  listSignins,
  markSignin,
  upsertSignin,
} from "./browser-profiles.mjs";


function probeKind(signin) {
  return signin?.probe?.kind || (signin?.slug === "google" ? "google" : "cookies");
}

async function listAll() {
  const signins = dbReady() ? await listSignins() : [];
  let sites = [];
  try {
    sites = dbReady() ? await listSites() : [];
  } catch {
    sites = [];
  }
  return {
    profile: SHARED_PROFILE_SLUG,
    capabilities: await capabilities(),
    session: sessionStatus(SHARED_PROFILE_SLUG),
    signins,
    sites: sites.map((site) => ({
      slug: site.slug,
      name: site.name,
      origin: site.origin,
      kind: "form",
      signedIn: Boolean(site.lastLoginAt) && !site.lastError,
      lastAuthAt: site.lastLoginAt || null,
      lastError: site.lastError || null,
      managedAt: "/admin#sites",
    })),
  };
}

async function probeAndMark(slug) {
  const signin = await getSignin(slug);
  if (!signin) throw new Error(`Unknown sign-in: ${slug}`);
  const status = await authStatus(SHARED_PROFILE_SLUG, {
    origin: signin.origin,
    kind: probeKind(signin),
  });
  const row = await markSignin(slug, {
    signedIn: status.signedIn,
    error: status.signedIn ? null : status.evidence,
  });
  return { ...status, signin: row };
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {URL} url
 * @param {{
 *   json: Function;
 *   readBody: Function;
 *   sanitizeError: Function;
 *   owner: boolean;
 * }} ctx
 */
export async function handleBrowser(req, res, url, ctx) {
  const { json, readBody, sanitizeError, owner } = ctx;
  const pathname = url.pathname;
  const method = req.method || "GET";

  if (!pathname.startsWith("/api/browser")) return false;

  if (dbReady()) await ensureBrowserSchema();

  if (method === "GET" && pathname === "/api/browser") {
    json(res, 200, await listAll());
    return true;
  }

  if (method === "GET" && pathname === "/api/browser/status") {
    json(res, 200, await capabilities());
    return true;
  }

  if (method === "GET" && pathname === "/api/browser/signins") {
    json(res, 200, { signins: dbReady() ? await listSignins() : [] });
    return true;
  }

  if (method === "POST" && pathname === "/api/browser/signins") {
    if (!owner) {
      json(res, 403, { error: "Owner only" });
      return true;
    }
    if (!dbReady()) {
      json(res, 503, { error: "Database is not connected" });
      return true;
    }
    const body = JSON.parse((await readBody(req)) || "{}");
    const signin = await upsertSignin(body);
    json(res, 200, { signin });
    return true;
  }

  {
    const del = pathname.match(/^\/api\/browser\/signins\/([^/]+)$/);
    if (del && method === "DELETE") {
      if (!owner) {
        json(res, 403, { error: "Owner only" });
        return true;
      }
      const slug = decodeURIComponent(del[1]);
      await deleteSignin(slug);
      json(res, 200, { ok: true, slug });
      return true;
    }
  }

  if (pathname === "/api/browser/session" && method === "GET") {
    json(res, 200, sessionStatus(SHARED_PROFILE_SLUG));
    return true;
  }

  if (pathname === "/api/browser/session" && method === "POST") {
    if (!owner) {
      json(res, 403, { error: "Owner only" });
      return true;
    }
    const body = JSON.parse((await readBody(req)) || "{}");
    const headed = body.headed === true || (body.headed !== false && wantsHeadedLogin());
    const signin = body.slug && dbReady() ? await getSignin(body.slug) : null;
    const target = String(body.url || signin?.loginUrl || "https://accounts.google.com/");
    await ensureSession(SHARED_PROFILE_SLUG, { headless: !headed });
    const result = await navigate(SHARED_PROFILE_SLUG, target);
    json(res, 200, {
      ok: true,
      headed,
      signin: signin?.slug || null,
      ...result,
    });
    return true;
  }

  if (pathname === "/api/browser/session" && method === "DELETE") {
    if (!owner) {
      json(res, 403, { error: "Owner only" });
      return true;
    }
    json(res, 200, await closeSession(SHARED_PROFILE_SLUG));
    return true;
  }

  if (pathname === "/api/browser/session/navigate" && method === "POST") {
    if (!owner) {
      json(res, 403, { error: "Owner only" });
      return true;
    }
    const body = JSON.parse((await readBody(req)) || "{}");
    json(res, 200, await navigate(SHARED_PROFILE_SLUG, String(body.url || "")));
    return true;
  }

  if (pathname === "/api/browser/session/input" && method === "POST") {
    if (!owner) {
      json(res, 403, { error: "Owner only" });
      return true;
    }
    const body = JSON.parse((await readBody(req)) || "{}");
    const type = String(body.type || "click");
    if (type === "click") json(res, 200, await clickAt(SHARED_PROFILE_SLUG, body.x, body.y));
    else if (type === "type") json(res, 200, await typeRef(SHARED_PROFILE_SLUG, { text: body.text, submit: body.submit }));
    else if (type === "key") json(res, 200, await pressKey(SHARED_PROFILE_SLUG, String(body.key || "Enter")));
    else json(res, 400, { error: `Unknown input type ${type}` });
    return true;
  }

  if (pathname === "/api/browser/session/done" && method === "POST") {
    if (!owner) {
      json(res, 403, { error: "Owner only" });
      return true;
    }
    const body = JSON.parse((await readBody(req)) || "{}");
    const slug = String(body.slug || "google");
    json(res, 200, await probeAndMark(slug));
    return true;
  }

  if (pathname === "/api/browser/session/stream" && method === "GET") {
    if (!owner) {
      json(res, 403, { error: "Owner only" });
      return true;
    }
    await ensureSession(SHARED_PROFILE_SLUG);
    const release = holdLease(SHARED_PROFILE_SLUG);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    let closed = false;
    const send = async () => {
      if (closed || res.writableEnded) return;
      try {
        const frame = await screenshotJpeg(SHARED_PROFILE_SLUG);
        res.write(`data: ${JSON.stringify(frame)}\n\n`);
      } catch (error) {
        res.write(`data: ${JSON.stringify({ error: sanitizeError(error) })}\n\n`);
      }
    };
    await send();
    const timer = setInterval(() => void send(), 700);
    const stop = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      release();
    };
    req.on("close", stop);
    res.on("close", stop);
    return true;
  }

  if (pathname === "/api/browser/act" && method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const op = String(body.op || "");
    const slug = SHARED_PROFILE_SLUG;
    if (op === "tabs") json(res, 200, await listTabs(slug));
    else if (op === "new_tab") json(res, 200, await newTab(slug, body.url || ""));
    else if (op === "switch_tab") json(res, 200, await switchTab(slug, String(body.tabId || "")));
    else if (op === "close_tab") json(res, 200, await closeTab(slug, String(body.tabId || "")));
    else if (op === "navigate") json(res, 200, await navigate(slug, String(body.url || "")));
    else if (op === "snapshot") json(res, 200, await snapshot(slug));
    else if (op === "click") json(res, 200, await clickRef(slug, String(body.ref || "")));
    else if (op === "type") json(res, 200, await typeRef(slug, { ref: body.ref, text: body.text, submit: body.submit }));
    else if (op === "press") json(res, 200, await pressKey(slug, String(body.key || "")));
    else if (op === "screenshot") json(res, 200, await screenshotJpeg(slug));
    else if (op === "wait") json(res, 200, await waitFor(slug, { timeoutMs: body.timeoutMs, urlIncludes: body.urlIncludes }));
    else if (op === "auth_status") {
      const signin = body.slug && dbReady() ? await getSignin(body.slug) : null;
      json(
        res,
        200,
        await authStatus(slug, {
          origin: body.origin || signin?.origin || "",
          kind: body.kind || probeKind(signin),
        }),
      );
    } else json(res, 400, { error: `Unknown op ${op}` });
    return true;
  }

  return false;
}

