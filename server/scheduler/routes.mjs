// HTTP route handler for /api/schedules/* endpoints.

import { companyHostContext } from "../../document_inteligence/host.mjs";
import { schedulableAgents } from './actions.mjs';
import {
  previewSchedule,
  createSchedule,
  listCompanySchedules,
  getSchedule,
  updateScheduleService,
  pauseScheduleService,
  resumeScheduleService,
  cancelScheduleService,
  getScheduleHistoryService,
} from "./service.mjs";

export async function handleSchedulerRoutes(req, res, url, { user, readBody, json }) {
  const pathname = url.pathname;
  if (!pathname.startsWith("/api/schedules")) return false;

  // Authentication check
  if (!user || user.active === false) {
    json(res, 401, { error: "Please sign in to access schedules" });
    return true;
  }
  if (!['GET','HEAD','OPTIONS'].includes(req.method) && req.headers?.['sec-fetch-site'] === 'cross-site') {
    json(res,403,{error:'Open this app to change schedules'});
    return true;
  }

  let companyId;
  try {
    if (req.method === 'GET' && pathname === '/api/schedules/agents') {
      json(res,200,{agents:await schedulableAgents()});
      return true;
    }
    companyId = user.company_tenant_id;
    if (!companyId) throw new Error('Company tenant is required');
  } catch {
    json(res, 503, { error: "Company context not ready" });
    return true;
  }

  const ctx = {
    companyId,
    userId: user.id,
    user,
  };

  try {
    // POST /api/schedules/preview
    if (req.method === "POST" && pathname === "/api/schedules/preview") {
      const body = JSON.parse((await readBody(req)) || "{}");
      json(res, 200, previewSchedule(body));
      return true;
    }

    // GET /api/schedules
    if (req.method === "GET" && pathname === "/api/schedules") {
      const query = {
        from: url.searchParams.get("from") || undefined,
        to: url.searchParams.get("to") || undefined,
        status: url.searchParams.get("status") || undefined,
        preset: url.searchParams.get("preset") || undefined,
        limit: url.searchParams.get("limit") || undefined,
      };
      const result = await listCompanySchedules(ctx, query);
      json(res, 200, result);
      return true;
    }

    // POST /api/schedules
    if (req.method === "POST" && pathname === "/api/schedules") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const result = await createSchedule(ctx, body);
      json(res, 201, result);
      return true;
    }

    const matchId = pathname.match(/^\/api\/schedules\/([^/]+)(?:\/(pause|resume|cancel|history))?$/);
    if (matchId) {
      const id = decodeURIComponent(matchId[1]);
      const sub = matchId[2];

      if (sub === "history" && req.method === "GET") {
        const limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : 20;
        const result = await getScheduleHistoryService(ctx, { schedule_id: id, limit });
        json(res, 200, result);
        return true;
      }

      if (sub === "pause" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const result = await pauseScheduleService(ctx, { schedule_id: id, expected_revision: body.expected_revision });
        json(res, 200, result);
        return true;
      }

      if (sub === "resume" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const result = await resumeScheduleService(ctx, { schedule_id: id, expected_revision: body.expected_revision });
        json(res, 200, result);
        return true;
      }

      if (sub === "cancel" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const result = await cancelScheduleService(ctx, { schedule_id: id, expected_revision: body.expected_revision });
        json(res, 200, result);
        return true;
      }

      if (!sub && req.method === "GET") {
        const schedule = await getSchedule(ctx, id);
        json(res, 200, { schedule });
        return true;
      }

      if (!sub && (req.method === "PATCH" || req.method === "PUT")) {
        const body = JSON.parse((await readBody(req)) || "{}");
        const result = await updateScheduleService(ctx, { ...body, schedule_id: id });
        json(res, 200, result);
        return true;
      }
    }

    json(res, 404, { error: "Schedule endpoint not found" });
    return true;
  } catch (error) {
    const statusCode = error?.code === "CONFLICT" ? 409 : error?.code === "NOT_FOUND" ? 404 : error?.code === "PERMISSION_DENIED" ? 403 : 400;
    json(res, statusCode, { error: error instanceof Error ? error.message : String(error) });
    return true;
  }
}
