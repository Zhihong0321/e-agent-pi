import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: true,
    env: process.env,
  });
  child.on("exit", (code) => {
    if (code && code !== 0) process.exit(code);
  });
  return child;
}

const api = run("node", ["server/index.mjs"]);
const ui = run("npx", ["vite", "--host", "127.0.0.1"]);

function shutdown() {
  api.kill();
  ui.kill();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
