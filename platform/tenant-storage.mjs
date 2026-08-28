import crypto from "node:crypto";
import path from "node:path";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { validTenantId } from "./tenant-context.mjs";

const OBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireTenant(tenantId) {
  if (!validTenantId(tenantId)) throw new Error("tenant_context_required");
  return String(tenantId).toLowerCase();
}

function requireObjectId(objectId) {
  if (!OBJECT_ID.test(String(objectId || ""))) throw new Error("storage_object_id_invalid");
  return String(objectId).toLowerCase();
}

export function safeDownloadName(value) {
  const name = String(value || "download").normalize("NFKC").replace(/[\u0000-\u001f\u007f/\\";\r\n]/g, "_").trim();
  return name.slice(0, 180) || "download";
}

export class TenantFilesystemStorage {
  constructor({ root }) {
    if (!path.isAbsolute(String(root || ""))) throw new Error("tenant_storage_root_must_be_absolute");
    this.root = path.resolve(root);
  }
  get configured() { return true; }
  objectPath(tenantId, objectId) {
    const tenant = requireTenant(tenantId), object = requireObjectId(objectId);
    const resolved = path.resolve(this.root, tenant, object);
    if (!resolved.startsWith(`${this.root}${path.sep}${tenant}${path.sep}`)) throw new Error("tenant_storage_path_escape");
    return resolved;
  }
  storageKey(tenantId, objectId) { return `${requireTenant(tenantId)}/${requireObjectId(objectId)}`; }
  async put(tenantId, bytes, { objectId = crypto.randomUUID() } = {}) {
    const target = this.objectPath(tenantId, objectId), directory = path.dirname(target);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${target}.${crypto.randomUUID()}.upload`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, target);
    const info = await stat(target);
    return { objectId, storageKey: this.storageKey(tenantId, objectId), sizeBytes: info.size, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
  }
  async get(tenantId, objectId) { return readFile(this.objectPath(tenantId, objectId)); }
  async delete(tenantId, objectId) { await rm(this.objectPath(tenantId, objectId), { force: true }); }
  async listPhysical(tenantId) {
    const directory = path.resolve(this.root, requireTenant(tenantId));
    try { return (await readdir(directory)).filter((entry) => OBJECT_ID.test(entry)).sort(); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }
}

export class UnconfiguredTenantStorage {
  get configured() { return false; }
  async put() { throw new Error("tenant_storage_adapter_not_configured"); }
  async get() { throw new Error("tenant_storage_adapter_not_configured"); }
  async delete() { throw new Error("tenant_storage_adapter_not_configured"); }
}
