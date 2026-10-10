import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Every job belongs to one company. A job is found, listed or reused only by that company; a missing
// company is an error, never "all companies".
const needCompany = (companyId) => {
  if (typeof companyId !== "string" || !companyId.trim()) throw new Error("Company tenant is required");
  return companyId.trim();
};

export class AdsResearchStore {
  constructor(root) {
    this.root = root;
    this.file = path.join(root, "jobs.json");
    this.jobs = new Map();
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;
    await mkdir(this.root, { recursive: true });
    try {
      const rows = JSON.parse(await readFile(this.file, "utf8"));
      for (const row of Array.isArray(rows) ? rows : []) this.jobs.set(row.id, row);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    this.loaded = true;
  }

  async save() {
    await mkdir(this.root, { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify([...this.jobs.values()], null, 2));
    const { rename } = await import("node:fs/promises");
    await rename(temp, this.file);
  }

  async enqueue(input) {
    await this.load();
    needCompany(input.companyId);
    const existing = [...this.jobs.values()].find((row) =>
      row.companyId === input.companyId && row.country === input.country && row.keyword === input.keyword && row.language === input.language &&
      ["queued", "running", "complete"].includes(row.status),
    );
    if (existing) return { ...existing, cached: true };
    const row = {
      id: randomUUID(),
      ...input,
      status: "queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      result: null,
      error: null,
    };
    this.jobs.set(row.id, row);
    await this.save();
    return { ...row, cached: false };
  }

  async get(id, companyId) {
    await this.load();
    const row = this.jobs.get(id);
    return row && row.companyId === needCompany(companyId) ? row : null;
  }

  async update(id, patch) {
    await this.load();
    const row = this.jobs.get(id);
    if (!row) return null;
    const next = { ...row, ...patch, updatedAt: new Date().toISOString() };
    this.jobs.set(id, next);
    await this.save();
    return next;
  }
}
