import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,symlink,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {TenantFilesystemStorage} from '../platform/tenant-storage.mjs';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',FILE='33333333-3333-4333-8333-333333333333';

test('tenant symlinks cannot redirect reads, writes or deletions',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wb-storage-links-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new TenantFilesystemStorage({root});const saved=await store.put(B,Buffer.from('protected'),{objectId:FILE});
 await symlink(path.join(root,B),path.join(root,A),'dir');
 for(const action of [()=>store.get(A,FILE),()=>store.put(A,Buffer.from('overwrite'),{objectId:FILE}),()=>store.delete(A,FILE),()=>store.listPhysical(A)])await assert.rejects(action,/ENOTDIR|ELOOP/);
 assert.equal((await store.get(B,saved.objectId)).toString(),'protected');
});

test('object symlinks and existing versions cannot be followed or replaced',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wb-storage-object-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new TenantFilesystemStorage({root});await store.put(B,Buffer.from('protected'),{objectId:FILE});
 await mkdir(path.join(root,A));await symlink(path.join(root,B,FILE),path.join(root,A,FILE));
 await assert.rejects(()=>store.get(A,FILE),/ELOOP/);
 await assert.rejects(()=>store.put(A,Buffer.from('overwrite'),{objectId:FILE}),/EEXIST/);
 await assert.rejects(()=>store.put(B,Buffer.from('overwrite'),{objectId:FILE}),/EEXIST/);
 assert.equal((await readFile(path.join(root,B,FILE))).toString(),'protected');
 assert.deepEqual(await store.listPhysical(A),[]);
 // A fresh instance reads the persisted bytes without in-memory state.
 assert.equal((await new TenantFilesystemStorage({root}).get(B,FILE)).toString(),'protected');
});

test('storage root itself must be a directory, not a symbolic link',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wb-storage-root-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(path.join(root,'real'));await symlink(path.join(root,'real'),path.join(root,'link'));
 await assert.rejects(()=>new TenantFilesystemStorage({root:path.join(root,'link')}).put(A,Buffer.from('no')),/ENOTDIR|ELOOP/);
});
