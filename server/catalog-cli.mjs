#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { closeDb, connectDb } from "./db.mjs";
import {
  attachAgentResources,
  createAgent,
  createMcpServer,
  deleteAgent,
  deleteMcpServer,
  deleteSkill,
  getAgent,
  getMcpServer,
  getSkill,
  installSkill,
  listAgents,
  listMcpServers,
  listSkills,
  publicAgent,
  publicMcp,
  publicSkill,
  rescanSkillLibrary,
  updateAgent,
  updateMcpServer,
} from "./catalog.mjs";

const USAGE = `Cloud Pi catalog CLI. Prints JSON.

  node $CLOUD_PI_CATALOG agents list
  node $CLOUD_PI_CATALOG agents get <id-or-slug>
  node $CLOUD_PI_CATALOG agents create --name NAME [--short S] [--color emerald] [--headline ...] [--description ...] [--role TEXT | --role-file PATH]
  node $CLOUD_PI_CATALOG agents update <id> [--name ...] [--role TEXT | --role-file PATH]
  node $CLOUD_PI_CATALOG agents attach <id> [--skill slug] [--mcp slug]
  node $CLOUD_PI_CATALOG agents detach <id> [--skill slug] [--mcp slug]
  node $CLOUD_PI_CATALOG agents delete <id>

  node $CLOUD_PI_CATALOG skills list
  node $CLOUD_PI_CATALOG skills get <id-or-slug>
  node $CLOUD_PI_CATALOG skills install [--file PATH | --url URL | --content MD] [--name slug] [--description ...]
  node $CLOUD_PI_CATALOG skills install-impeccable [--force]
  node $CLOUD_PI_CATALOG skills delete <id-or-slug>
  node $CLOUD_PI_CATALOG skills rescan

  node $CLOUD_PI_CATALOG mcp list
  node $CLOUD_PI_CATALOG mcp get <id-or-slug>
  node $CLOUD_PI_CATALOG mcp add --name NAME [--command CMD] [--args "..."] [--url URL] [--env JSON] [--description ...]
  node $CLOUD_PI_CATALOG mcp update <id> [...]
  node $CLOUD_PI_CATALOG mcp delete <id-or-slug>
`;

function parseArgv(argv) {
  /** @type {Record<string, string | boolean | string[]> & { _: string[] }} */
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      out._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    i += 1;
    if (key === "skill" || key === "mcp") {
      const list = Array.isArray(out[key]) ? out[key] : [];
      list.push(next);
      out[key] = list;
    } else {
      out[key] = next;
    }
  }
  return out;
}

function flag(opts, key) {
  const value = opts[key];
  if (value === true || value === false || value === undefined) return "";
  return String(value);
}

function flagList(opts, key) {
  const value = opts[key];
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value) return [value];
  return [];
}

async function roleFromOpts(opts) {
  const file = flag(opts, "role-file");
  if (file) return readFile(file, "utf8");
  return flag(opts, "role");
}

function dumpAgent(agent) {
  return publicAgent(agent, { includeRole: true });
}

async function run(argv) {
  const opts = parseArgv(argv);
  const [group, action, target] = opts._;
  if (!group || group === "help" || opts.help) {
    return { ok: true, usage: USAGE.trim() };
  }

  await connectDb();

  if (group === "agents") {
    if (action === "list") return { ok: true, agents: (await listAgents()).map((row) => dumpAgent(row)) };
    if (action === "get") {
      const agent = await getAgent(target);
      if (!agent) throw new Error(`Agent not found: ${target}`);
      return { ok: true, agent: dumpAgent(agent) };
    }
    if (action === "create") {
      const rolePrompt = await roleFromOpts(opts);
      if (!flag(opts, "name")) throw new Error("--name is required");
      const agent = await createAgent({
        name: flag(opts, "name"),
        short: flag(opts, "short"),
        color: flag(opts, "color") || "violet",
        headline: flag(opts, "headline"),
        description: flag(opts, "description"),
        rolePrompt,
      });
      return { ok: true, agent: dumpAgent(agent) };
    }
    if (action === "update") {
      const current = await getAgent(target);
      if (!current) throw new Error(`Agent not found: ${target}`);
      const rolePrompt = await roleFromOpts(opts);
      const patch = {};
      if (flag(opts, "name")) patch.name = flag(opts, "name");
      if (flag(opts, "short")) patch.short = flag(opts, "short");
      if (flag(opts, "color")) patch.color = flag(opts, "color");
      if (flag(opts, "headline")) patch.headline = flag(opts, "headline");
      if (flag(opts, "description")) patch.description = flag(opts, "description");
      if (rolePrompt) patch.rolePrompt = rolePrompt;
      const agent = await updateAgent(current.id, patch);
      return { ok: true, agent: dumpAgent(agent) };
    }
    if (action === "attach" || action === "detach") {
      const agent = await attachAgentResources(target, {
        skills: flagList(opts, "skill"),
        mcp: flagList(opts, "mcp"),
        detach: action === "detach",
      });
      return { ok: true, agent: dumpAgent(agent) };
    }
    if (action === "delete") {
      await deleteAgent(target);
      return { ok: true, deleted: target };
    }
  }

  if (group === "skills") {
    if (action === "list") return { ok: true, skills: (await listSkills()).map((row) => publicSkill(row)) };
    if (action === "get") {
      const skill = await getSkill(target);
      if (!skill) throw new Error(`Skill not found: ${target}`);
      return { ok: true, skill: { ...publicSkill(skill), content: skill.content } };
    }
    if (action === "rescan") {
      const skills = await rescanSkillLibrary();
      return { ok: true, skills: skills.map((row) => publicSkill(row)) };
    }
    if (action === "install") {
      let content = flag(opts, "content");
      const file = flag(opts, "file");
      if (file) content = await readFile(file, "utf8");
      const skill = await installSkill({
        name: flag(opts, "name") || undefined,
        description: flag(opts, "description") || undefined,
        url: flag(opts, "url") || undefined,
        content: content || undefined,
        source: "cli",
      });
      return { ok: true, skill: publicSkill(skill), note: "Installed to library. Attach with: agents attach <agent> --skill " + skill.slug };
    }
    if (action === "install-impeccable") {
      const { ensureImpeccableForWebsite } = await import("./impeccable.mjs");
      return { ok: true, ...(await ensureImpeccableForWebsite({ force: Boolean(opts.force) })) };
    }
    if (action === "delete") {
      const skill = await getSkill(target);
      if (!skill) throw new Error(`Skill not found: ${target}`);
      await deleteSkill(skill.id);
      return { ok: true, deleted: skill.slug };
    }
  }

  if (group === "mcp") {
    if (action === "list") {
      return { ok: true, servers: (await listMcpServers()).map((row) => publicMcp(row, { secrets: false })) };
    }
    if (action === "get") {
      const server = await getMcpServer(target);
      if (!server) throw new Error(`MCP server not found: ${target}`);
      return { ok: true, server: publicMcp(server, { secrets: true }) };
    }
    if (action === "add") {
      if (!flag(opts, "name")) throw new Error("--name is required");
      let env = {};
      if (flag(opts, "env")) env = JSON.parse(flag(opts, "env"));
      const server = await createMcpServer({
        name: flag(opts, "name"),
        description: flag(opts, "description"),
        command: flag(opts, "command"),
        args: flag(opts, "args"),
        url: flag(opts, "url"),
        env,
      });
      return { ok: true, server: publicMcp(server, { secrets: false }), note: "Saved to library. Attach with: agents attach <agent> --mcp " + server.slug };
    }
    if (action === "update") {
      const current = await getMcpServer(target);
      if (!current) throw new Error(`MCP server not found: ${target}`);
      const patch = {};
      if (flag(opts, "name")) patch.name = flag(opts, "name");
      if (flag(opts, "description")) patch.description = flag(opts, "description");
      if (flag(opts, "command")) patch.command = flag(opts, "command");
      if (flag(opts, "args")) patch.args = flag(opts, "args");
      if (flag(opts, "url")) patch.url = flag(opts, "url");
      if (flag(opts, "env")) patch.env = JSON.parse(flag(opts, "env"));
      const server = await updateMcpServer(current.id, patch);
      return { ok: true, server: publicMcp(server, { secrets: false }) };
    }
    if (action === "delete") {
      const server = await getMcpServer(target);
      if (!server) throw new Error(`MCP server not found: ${target}`);
      await deleteMcpServer(server.id);
      return { ok: true, deleted: server.slug };
    }
  }

  throw new Error(`Unknown command. ${USAGE}`);
}

try {
  const result = await run(process.argv.slice(2));
  console.log(JSON.stringify(result, null, 2));
  await closeDb().catch(() => {});
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  await closeDb().catch(() => {});
  process.exitCode = 1;
}
