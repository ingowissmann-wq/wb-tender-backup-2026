import crypto from "node:crypto";
import path from "node:path";
import { mkdir, open, readdir, link, unlink } from "node:fs/promises";
import { constants } from "node:fs";
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
  async openTenantDirectory(tenantId, create = false) {
    const tenant = requireTenant(tenantId);
    if (create) await mkdir(this.root, { recursive: true, mode: 0o700 });
    const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
    const root = await open(this.root, flags);
    try {
      const directory = `/proc/self/fd/${root.fd}/${tenant}`;
      if (create) {
        try { await mkdir(directory, { mode: 0o700 }); await root.sync(); }
        catch (error) { if (error.code !== "EEXIST") throw error; }
      }
      // Pin the directory inode. A concurrent path replacement cannot redirect
      // the following operations into another tenant or a symlink target.
      return await open(directory, flags);
    } finally { await root.close(); }
  }
  async put(tenantId, bytes, { objectId = crypto.randomUUID() } = {}) {
    const object = requireObjectId(objectId), directory = await this.openTenantDirectory(tenantId, true);
    const prefix = `/proc/self/fd/${directory.fd}`;
    const target = `${prefix}/${object}`, temporary = `${prefix}/${object}.${crypto.randomUUID()}.upload`;
    let ownedTemporary = false;
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      ownedTemporary = true;
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      // Atomic publication without replacing a pre-existing document version.
      await link(temporary, target);
      await unlink(temporary);
      ownedTemporary = false;
      await directory.sync();
      return { objectId: object, storageKey: this.storageKey(tenantId, object), sizeBytes: Buffer.byteLength(bytes), sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
    } finally {
      try {
        if (ownedTemporary) try { await unlink(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
      } finally { await directory.close(); }
    }
  }
  async get(tenantId, objectId) {
    const object = requireObjectId(objectId), directory = await this.openTenantDirectory(tenantId);
    try {
      const file = await open(`/proc/self/fd/${directory.fd}/${object}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!(await file.stat()).isFile()) throw new Error("storage_regular_file_required");
        return await file.readFile();
      } finally { await file.close(); }
    } finally { await directory.close(); }
  }
  async delete(tenantId, objectId) {
    const object = requireObjectId(objectId);
    let directory;
    try {
      directory = await this.openTenantDirectory(tenantId);
      await unlink(`/proc/self/fd/${directory.fd}/${object}`);
      await directory.sync();
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    finally { if (directory) await directory.close(); }
  }
  async listPhysical(tenantId) {
    let directory;
    try {
      directory = await this.openTenantDirectory(tenantId);
      const entries = await readdir(`/proc/self/fd/${directory.fd}`, { withFileTypes: true });
      return entries.filter(entry => entry.isFile() && OBJECT_ID.test(entry.name)).map(entry => entry.name).sort();
    } catch (error) { if (error.code === "ENOENT") return []; throw error; }
    finally { if (directory) await directory.close(); }
  }

}

export class UnconfiguredTenantStorage {
  get configured() { return false; }
  async put() { throw new Error("tenant_storage_adapter_not_configured"); }
  async get() { throw new Error("tenant_storage_adapter_not_configured"); }
  async delete() { throw new Error("tenant_storage_adapter_not_configured"); }
}
