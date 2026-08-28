import assert from "node:assert/strict";
import fs from "node:fs";
import Fastify from "fastify";
import pg from "pg";
import { registerAutopilotRoutes } from "../platform/autopilot-routes.mjs";
import { decoratePortalNavigation } from "../platform/portal-navigation.mjs";
import { loadTenderLinkEvidence } from "../platform/tender-link-evidence.mjs";

const pool = new pg.Pool({connectionString:fs.readFileSync(process.env.DATABASE_URL_FILE||"/run/secrets/database_url","utf8").trim(),max:2,options:"-c default_transaction_read_only=on -c statement_timeout=55000"});
const companies = (await pool.query("SELECT company_id,legal_name FROM tender.enterprise_company_links WHERE active ORDER BY legal_name")).rows,
  identity = {userId:"00000000-0000-4000-8000-000000000001",permissions:["tender.admin","tender.portal.manage","tender.view_assigned"],companyIds:companies.map(row=>String(row.company_id)),sectorSlugs:[]},
  app = Fastify({logger:false});
registerAutopilotRoutes(app,{pool,requirePermission:()=>async req=>{req.identity=identity;},csrf:async()=>{},visibleTender:async(req,reply,id)=>{const row=(await pool.query("SELECT * FROM tender.tenders WHERE id=$1",[id])).rows[0];if(!row){reply.code(404).send({error:"tender_not_found"});return null;}return row;}});
const get = async url => { const response=await app.inject({method:"GET",url}); assert.equal(response.statusCode,200,`GET failed: ${url} (${response.statusCode})`); return response; };
const byName = name => {const company=companies.find(row=>row.legal_name===name);assert.ok(company,name);return company;};
const before = (await pool.query("SELECT count(*)::int mappings,count(*) FILTER(WHERE active)::int active FROM tender.portal_credential_companies")).rows[0];
const results=[];
try {
  for (const name of ["WB-Facilitys GmbH","WB-Emergency Service GmbH"]) {
    const company=byName(name), response=await get(`/api/portals?company=${company.company_id}&q=RIB`), body=response.json();
    assert.equal(body.selectedCompany.name,name);assert.ok(body.items.every(item=>item.companyAccesses.length===1&&item.companyAccesses[0].companyName===name));assert.ok(body.items.every(item=>item.access.configured===false&&item.access.credentialId===null&&item.access.credentialVersion===null&&item.access.usernameMasked==null));
    results.push({company:name,phantomAccess:false});
  }
  const cleaning=byName("WB-Cleaning GmbH"), fixture=(await pool.query(`SELECT relevance.tender_id,relevance.service_line,version.id version_id FROM tender.current_service_relevance relevance JOIN LATERAL(SELECT id FROM tender.tender_versions WHERE tender_id=relevance.tender_id ORDER BY version DESC LIMIT 1)version ON true WHERE relevance.company_id=$1 ORDER BY relevance.tender_id LIMIT 1`,[cleaning.company_id])).rows[0];
  assert.ok(fixture);
  for (const q of ["RIB","meinauftrag","Deutsche eVergabe","DTVP","vergabe24.de"]) {const body=(await get(`/api/portals?company=${cleaning.company_id}&q=${encodeURIComponent(q)}&pageSize=25`)).json();assert.ok(body.total>0,q);assert.ok(body.items.length<=25,q);}
  const scoped=(await get(`/api/portals?company=${cleaning.company_id}&tender=${fixture.tender_id}&service=${encodeURIComponent(fixture.service_line)}&version=${fixture.version_id}&page=1&pageSize=25`)).json();
  assert.equal(scoped.companyLocked,true);assert.equal(scoped.selectedCompany.name,"WB-Cleaning GmbH");assert.ok(scoped.items.every(item=>item.companyAccesses.length===1&&item.companyAccesses[0].companyName==="WB-Cleaning GmbH"));
  const pageOne=(await get(`/api/portals?company=${cleaning.company_id}&page=1&pageSize=25`)).json(),pageTwo=(await get(`/api/portals?company=${cleaning.company_id}&page=2&pageSize=25`)).json();assert.equal(pageOne.items.length,25);assert.ok(pageTwo.items.length>0);assert.equal(pageOne.pageSize,25);
  const active=(await pool.query(`SELECT portal.id portal_id,company.company_id FROM tender.portal_read_sessions session JOIN tender.portal_credential_secrets credential ON credential.id=session.credential_id JOIN tender.portal_credential_companies scope ON scope.credential_id=credential.id AND scope.company_id=session.company_id AND scope.active JOIN tender.enterprise_company_links company ON company.company_id=session.company_id JOIN tender.portal_registry portal ON portal.id=session.portal_id WHERE tender.portal_session_effective_status(session.status,session.expires_at,session.revoked_at,session.verification_status)='ACTIVE' ORDER BY session.last_verified_at DESC LIMIT 1`)).rows[0];
  if(active){const body=(await get(`/api/portals?company=${active.company_id}&pageSize=50`)).json(),item=body.items.find(row=>String(row.portalId)===String(active.portal_id));assert.equal(item?.access.status,"LOGGED_IN");results.push({authoritativeActiveSession:"LOGGED_IN"});}
  const currentJob=(await pool.query(`SELECT job.id FROM tender.autopilot_queue job JOIN tender.portal_credential_companies scope ON scope.credential_id=job.credential_id AND scope.company_id=job.company_id AND scope.active JOIN tender.portal_credential_secrets credential ON credential.id=scope.credential_id AND credential.status='ACTIVE' WHERE job.action_type IN('TEST_PORTAL_CONNECTION','TEST_DOCUMENT_FETCH') ORDER BY job.created_at DESC LIMIT 1`)).rows[0];
  if(currentJob){await get(`/api/portal-access/jobs/${currentJob.id}`);results.push({persistentPortalJobReadable:true});}
  const recognized=(await pool.query(`SELECT relevance.tender_id,relevance.company_id FROM tender.current_service_relevance relevance JOIN tender.current_tender_portal_mapping_truth truth ON truth.tender_id=relevance.tender_id WHERE truth.portal_id IS NOT NULL AND truth.mapping_status='UNIQUE_CANONICAL_PROFILE' ORDER BY relevance.tender_id LIMIT 1`)).rows[0],
    missingCandidates=(await pool.query(`SELECT relevance.tender_id,relevance.company_id FROM tender.current_service_relevance relevance JOIN tender.tenders tender ON tender.id=relevance.tender_id WHERE tender.source_code IN('TED','DOE') AND NOT EXISTS(SELECT 1 FROM tender.audit_events event WHERE event.action='tender_portal_mapping_confirmed' AND event.tender_id=tender.id AND event.metadata->>'companyId'=relevance.company_id::text) ORDER BY relevance.tender_id LIMIT 500`)).rows,
    missingEvidence=await loadTenderLinkEvidence(pool,missingCandidates.map(row=>row.tender_id)),
    missing=missingCandidates.find(row=>missingEvidence.get(String(row.tender_id))?.portalMapping?.status!=="EINDEUTIG_ZUGEORDNET");
  assert.ok(recognized&&missing);
  const links=await decoratePortalNavigation(pool,[recognized,missing],{returnTo:"/admin/ausschreibungen"});
  assert.match(links[0].portal_navigation_href,/\/portalzugaenge\/bearbeiten\?/);assert.match(links[1].portal_navigation_href,/\/portalzugaenge\?/);assert.match(links[1].portal_navigation_href,/mode=search/);
  results.push({recognizedHref:links[0].portal_navigation_href,missingHref:links[1].portal_navigation_href});
  const after=(await pool.query("SELECT count(*)::int mappings,count(*) FILTER(WHERE active)::int active FROM tender.portal_credential_companies")).rows[0];assert.deepEqual(after,before);
  console.log(JSON.stringify({passed:true,readOnly:true,companyScope:true,searches:5,pagination:true,mutation:false,results},null,2));
} finally {await app.close();await pool.end();}
