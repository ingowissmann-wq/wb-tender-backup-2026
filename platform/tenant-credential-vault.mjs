import crypto from 'node:crypto';
import fs from 'node:fs';
import { validTenantId, withTenantContext } from './tenant-context.mjs';

const fail = (code, statusCode = 503) => Object.assign(new Error(code), { statusCode });
const identifier = /^[A-Za-z0-9_-]{1,64}$/;
const metadataColumns = 'id,tenant_id,company_id,portal_id,label,revision,key_version,created_at,updated_at';
const aad = (scope) => {
  if (!['id','tenant_id','company_id','portal_id'].every((key) => validTenantId(scope[key])) || !Number.isSafeInteger(scope.revision) || scope.revision < 1 || !identifier.test(scope.key_version)) throw fail('credential_scope_invalid', 400);
  return Buffer.from(JSON.stringify(['WB_TENDER_TENANT_CREDENTIAL_V1',scope.tenant_id,scope.company_id,scope.portal_id,scope.id,scope.revision,scope.key_version]));
};

// File-only keys. Open the final component without following a symlink, and
// check the opened inode rather than racing stat(path) against readFile(path).
export function loadCredentialKeyring(path) {
  if (!path) throw fail('portal_credential_keyring_unconfigured');
  let fd;
  try {
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 32768) throw fail('portal_credential_keyring_invalid');
    const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (!identifier.test(value.active) || !value.keys || typeof value.keys !== 'object' || Array.isArray(value.keys)) throw fail('portal_credential_keyring_invalid');
    const keys = new Map();
    for (const [version, encoded] of Object.entries(value.keys)) {
      if (!identifier.test(version) || typeof encoded !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw fail('portal_credential_keyring_invalid');
      const key = Buffer.from(encoded, 'base64');
      if (key.length !== 32 || key.toString('base64') !== encoded) throw fail('portal_credential_keyring_invalid');
      keys.set(version, key);
    }
    if (!keys.has(value.active)) throw fail('portal_credential_keyring_invalid');
    return { active: value.active, keys };
  } catch { throw fail('portal_credential_keyring_invalid'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function sealPortalCredential(keyring, scope, secret) {
  if (!secret || typeof secret.username !== 'string' || !secret.username.trim() || secret.username.length > 320 || typeof secret.password !== 'string' || !secret.password || secret.password.length > 4096) throw fail('portal_credential_input_invalid',400);
  const key = keyring.keys.get(scope.key_version);
  if (!key) throw fail('portal_credential_key_unavailable');
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm',key,nonce);
  cipher.setAAD(aad(scope));
  const plaintext = Buffer.from(JSON.stringify({username:secret.username,password:secret.password}));
  try {
    const ciphertext = Buffer.concat([cipher.update(plaintext),cipher.final()]);
    return Buffer.concat([nonce,cipher.getAuthTag(),ciphertext]);
  } finally { plaintext.fill(0); }
}

export function openPortalCredential(keyring, scope, envelope) {
  let plaintext;
  try {
    if (!Buffer.isBuffer(envelope) || envelope.length < 30 || envelope.length > 32768) throw fail('invalid_envelope');
    const key = keyring.keys.get(scope.key_version);
    if (!key) throw fail('missing_key');
    const decipher = crypto.createDecipheriv('aes-256-gcm',key,envelope.subarray(0,12));
    decipher.setAAD(aad(scope));
    decipher.setAuthTag(envelope.subarray(12,28));
    plaintext = Buffer.concat([decipher.update(envelope.subarray(28)),decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch { throw fail('portal_credential_integrity_failed'); }
  finally { plaintext?.fill(0); }
}

export class TenantCredentialVault {
  constructor({pool,keyringFile}) { this.pool=pool; this.keyringFile=keyringFile; }
  async list(context,companyId) {
    if (!validTenantId(companyId)) throw fail('company_not_found',404);
    return withTenantContext(this.pool,context,async(db)=>(await db.query(`SELECT ${metadataColumns} FROM tenant_portal.credential_vault WHERE tenant_id=$1 AND company_id=$2 ORDER BY created_at,id`,[context.id,companyId])).rows);
  }
  async save(context,{id,companyId,portalId,label,username,password,expectedRevision}) {
    if (![companyId,portalId].every(validTenantId) || (id && !validTenantId(id)) || typeof label !== 'string' || !label.trim() || label.trim().length>120) throw fail('portal_credential_input_invalid',400);
    if (id && (!Number.isSafeInteger(expectedRevision) || expectedRevision<1)) throw fail('credential_revision_required',400);
    const keyring=loadCredentialKeyring(this.keyringFile);
    return withTenantContext(this.pool,context,async(db)=>{
      const company=(await db.query("SELECT id FROM saas.tenant_companies WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE' FOR SHARE",[context.id,companyId])).rows[0];
      if (!company) throw fail('company_not_found',404);
      const portal=(await db.query('SELECT id FROM tender.portal_registry WHERE id=$1',[portalId])).rows[0];
      if (!portal) throw fail('portal_not_found',404);
      let previous;
      if (id) {
        previous=(await db.query('SELECT * FROM tenant_portal.credential_vault WHERE tenant_id=$1 AND company_id=$2 AND portal_id=$3 AND id=$4 FOR UPDATE',[context.id,companyId,portalId,id])).rows[0];
        if (!previous) throw fail('credential_not_found',404);
        if (previous.revision!==expectedRevision) throw fail('credential_revision_conflict',409);
      }
      const scope={id:id||crypto.randomUUID(),tenant_id:context.id,company_id:companyId,portal_id:portalId,revision:(previous?.revision||0)+1,key_version:keyring.active};
      const sealed=sealPortalCredential(keyring,scope,{username,password});
      if (previous) await db.query('UPDATE tenant_portal.credential_vault SET label=$2,ciphertext=$3,revision=$4,key_version=$5,updated_at=now() WHERE id=$1',[scope.id,label.trim(),sealed,scope.revision,scope.key_version]);
      else await db.query('INSERT INTO tenant_portal.credential_vault(id,tenant_id,company_id,portal_id,label,ciphertext,revision,key_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[scope.id,scope.tenant_id,companyId,portalId,label.trim(),sealed,scope.revision,scope.key_version]);
      const stored=(await db.query('SELECT * FROM tenant_portal.credential_vault WHERE id=$1',[scope.id])).rows[0];
      const checked=openPortalCredential(keyring,stored,stored.ciphertext);
      if (checked.username!==username || checked.password!==password) throw fail('portal_credential_readback_failed');
      await this.audit(db,context,scope.id,previous?'PORTAL_CREDENTIAL_UPDATED':'PORTAL_CREDENTIAL_CREATED');
      await this.audit(db,context,scope.id,'PORTAL_CREDENTIAL_READBACK_VERIFIED');
      return this.metadata(stored);
    });
  }
  metadata(row) { return Object.fromEntries(metadataColumns.split(',').map(key=>[key,row[key]])); }
  async audit(db,context,id,action) {
    await db.query("INSERT INTO saas.audit_events(tenant_id,actor_user_id,action,target_type,target_id) VALUES($1,$2,$3,'portal_credential',$4)",[context.id,context.actorUserId,action,id]);
  }
  async rotate(context,companyId,id,expectedRevision) {
    if (![companyId,id].every(validTenantId) || !Number.isSafeInteger(expectedRevision)) throw fail('portal_credential_input_invalid',400);
    const keyring=loadCredentialKeyring(this.keyringFile);
    return withTenantContext(this.pool,context,async(db)=>{
      const row=(await db.query('SELECT * FROM tenant_portal.credential_vault WHERE tenant_id=$1 AND company_id=$2 AND id=$3 FOR UPDATE',[context.id,companyId,id])).rows[0];
      if (!row) throw fail('credential_not_found',404);
      if (row.revision!==expectedRevision) throw fail('credential_revision_conflict',409);
      const secret=openPortalCredential(keyring,row,row.ciphertext);
      if (row.key_version===keyring.active) return this.metadata(row);
      const scope={...row,revision:row.revision+1,key_version:keyring.active};
      const sealed=sealPortalCredential(keyring,scope,secret);
      await db.query('UPDATE tenant_portal.credential_vault SET ciphertext=$2,revision=$3,key_version=$4,updated_at=now() WHERE id=$1',[id,sealed,scope.revision,scope.key_version]);
      const stored=(await db.query('SELECT * FROM tenant_portal.credential_vault WHERE id=$1',[id])).rows[0];
      const checked=openPortalCredential(keyring,stored,stored.ciphertext);
      if (checked.username!==secret.username || checked.password!==secret.password) throw fail('portal_credential_readback_failed');
      await this.audit(db,context,id,'PORTAL_CREDENTIAL_KEY_ROTATED');
      return this.metadata(stored);
    });
  }
}
