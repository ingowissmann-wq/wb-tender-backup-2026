import crypto from "node:crypto";
import { editRight as EDIT_RIGHT, mappingError, parameterByKey, parameterCatalog as minimumParameters } from "./parameter-catalog.mjs";
import { normalizeDecimal, parameterUnitRules, unitValidation, units } from "./unit-catalog.mjs";
import { readStatusBlockers } from "./status-blockers.mjs";
const normalizedInput=b=>{const rule=parameterUnitRules[b?.parameterKey];if(!rule)return {...b};const checked=unitValidation(b.parameterKey,b.unitId||b.unit),number=rule.numeric?normalizeDecimal(b.newValue):null;return {...b,unit:checked.unit?.id||String(b.unitId||b.unit||""),unitLabel:checked.unit?.label||null,newValue:rule.numeric&&number!==null?number:b.newValue,_unitError:checked.error,_numberInvalid:rule.numeric&&number===null}};
const validDate=(value)=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(value||""))return false;const date=new Date(`${value}T00:00:00Z`);return Number.isFinite(date.valueOf())&&date.toISOString().slice(0,10)===value};
export const validateDraft=(b)=>{
 const errors=[];
 if(!b.companyId)errors.push("companyId:company_required");
 if(!String(b.serviceLine||"").trim())errors.push("serviceLine:service_line_required");
 if(!String(b.parameterKey||"").trim())errors.push("parameterKey:parameter_required");
 else {const mapping=mappingError(b.parameterKey,b.category);if(mapping)errors.push(`parameterKey:${mapping.code}`)}
 if(b.newValue===undefined||b.newValue===null||b.newValue==="")errors.push("newValue:value_required");
 else if(JSON.stringify(b.newValue).length>10000)errors.push("newValue:value_too_long");
 if(!String(b.unit||"").trim())errors.push("unit:unit_required");
 else if(b._unitError)errors.push("unit:unit_mismatch");else if(!parameterUnitRules[b.parameterKey]&&parameterByKey[b.parameterKey]&&b.unit!==parameterByKey[b.parameterKey].expectedUnit)errors.push("unit:unit_mismatch");
 if(parameterUnitRules[b.parameterKey]?.numeric&&b._numberInvalid)errors.push("newValue:number_invalid");
 if(!String(b.source||"").trim())errors.push("source:source_required");
 if(b.dataAsOf&&!validDate(b.dataAsOf))errors.push("dataAsOf:data_as_of_invalid");
 if(!b.validFrom)errors.push("validFrom:valid_from_required");else if(!validDate(b.validFrom))errors.push("validFrom:valid_from_invalid");
 if(b.validUntil&&(!validDate(b.validUntil)||b.validUntil<b.validFrom))errors.push("validUntil:validity_invalid");
 if(!String(b.reason||"").trim())errors.push("reason:reason_required");
 if(!/^[0-9a-f-]{16,64}$/i.test(String(b.clientRequestId||"")))errors.push("clientRequestId:request_id_invalid");
 return errors;
};
const stable=(value)=>JSON.stringify(value,Object.keys(value||{}).sort());
const checksum=(value)=>crypto.createHash("sha256").update(stable(value)).digest("hex");
const can=(i,p)=>i.permissions.includes("tender.admin")||i.permissions.includes(p);
const scoped=(i,companyId)=>!companyId||i.permissions.includes("tender.admin")||i.companyIds.includes(companyId);
const requireScope=(req,reply,companyId)=>{if(!scoped(req.identity,companyId)){reply.code(403).send({error:"company_scope_forbidden"});return false}return true};
const SELF_APPROVE="tender.config.self_approve_activate";
const SECURITY_COST_KEYS=Object.freeze(["S01","S02","S03","S04"]);
const hasExact=(identity,permission)=>identity.permissions.includes(permission);
const germanActionError={permission:"Nur ein ausdrücklich berechtigter Vorstand darf eigene Entwürfe selbst freigeben und aktivieren.",mfa:"Für diese Aktion ist eine bestätigte MFA-Anmeldung erforderlich.",scope:"Die Version gehört nicht zu Ihrem Gesellschaftsbereich.",owner:"Es können ausschließlich eigene Entwürfe durch den Vorstand direkt aktiviert werden.",state:"Die Version befindet sich nicht mehr im erwarteten Entwurfsstatus.",validation:"Der Entwurf ist fachlich nicht vollständig und kann nicht aktiviert werden."};
const validateChange=(x)=>{
 const errors=[]; const value=x.newValue;
 if(!x.parameterKey?.trim())errors.push("parameter_required");
 if(value===undefined||value===null||value==="")errors.push("value_required");
 if(!x.source?.trim())errors.push("source_required");
 if(!x.validFrom)errors.push("valid_from_required");
 const mapping=mappingError(x.parameterKey,x.category);if(mapping)errors.push(mapping.code);
 const definition=parameterByKey[x.parameterKey],unitCheck=unitValidation(x.parameterKey,x.unitId||x.unit);if(unitCheck.error)errors.push("unit_mismatch");else if(!parameterUnitRules[x.parameterKey]&&definition&&x.unit&&x.unit!==definition.expectedUnit)errors.push("unit_mismatch");
 if(parameterUnitRules[x.parameterKey]?.numeric&&normalizeDecimal(x.newValue)===null)errors.push("number_invalid");
 if(x.validUntil&&x.validFrom&&x.validUntil<x.validFrom)errors.push("validity_invalid");
 if(/(?:lohn|kosten|db|volumen|entfernung|fahrzeit|kapazität|anteil)/i.test(x.parameterKey||"")&&Number(value)<0)errors.push("negative_value_forbidden");
 if(/zuschlag/i.test(x.parameterKey||"")&&(Number(value)<0||Number(value)>5))errors.push("supplement_out_of_range");
 if(/(?:lohn|kosten|db|volumen)/i.test(x.parameterKey||"")&&!x.unit)errors.push("unit_required");
 return errors;
};

const activateParameters=async(client,version,actorId)=>{
 await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`configuration-active:${version.company_id}:${version.service_line}`]);
 const changes=(await client.query("SELECT * FROM tender.configuration_changes WHERE version_id=$1 ORDER BY id FOR SHARE",[version.id])).rows;
 if(!changes.length)throw new Error("activation_without_changes");
 const prior=(await client.query(`SELECT parameter_key,version_id FROM tender.configuration_active_parameters
  WHERE company_id=$1 AND service_line=$2 AND parameter_key=ANY($3::text[]) FOR UPDATE`,[version.company_id,version.service_line,changes.map(x=>x.parameter_key)])).rows;
 for(const change of changes)await client.query(`INSERT INTO tender.configuration_active_parameters(company_id,service_line,parameter_key,version_id,change_id,activated_at,activated_by)
  VALUES($1,$2,$3,$4,$5,now(),$6)
  ON CONFLICT(company_id,service_line,parameter_key) DO UPDATE SET version_id=excluded.version_id,change_id=excluded.change_id,activated_at=excluded.activated_at,activated_by=excluded.activated_by,resolved_at=now()`,[version.company_id,version.service_line,change.parameter_key,version.id,change.id,actorId]);
 await client.query("UPDATE tender.configuration_versions SET status='ACTIVE',activated_at=now() WHERE id=$1",[version.id]);
 const replaced=[...new Set(prior.map(x=>x.version_id).filter(id=>id!==version.id))];
 if(replaced.length)await client.query(`UPDATE tender.configuration_versions v SET status='SUPERSEDED'
  WHERE v.id=ANY($1::uuid[]) AND NOT EXISTS(SELECT 1 FROM tender.configuration_active_parameters a WHERE a.version_id=v.id)`,[replaced]);
 if(version.service_line==="security"){
  const complete=(await client.query(`SELECT count(*)::int n FROM tender.configuration_active_parameters a JOIN tender.configuration_changes c ON c.id=a.change_id
   WHERE a.company_id=$1 AND a.service_line='security' AND a.parameter_key=ANY($2::text[]) AND c.new_value IS NOT NULL AND c.valid_from<=current_date AND (c.valid_until IS NULL OR c.valid_until>=current_date)`,[version.company_id,SECURITY_COST_KEYS])).rows[0].n===SECURITY_COST_KEYS.length;
  if(complete)await client.query(`INSERT INTO tender.autopilot_queue(request_id,action_type,tender_id,tender_version_id,notice_id,lot_key,company_id,service_scope,enrichment_version_id,assessment_version_id,configuration_version_id,idempotency_key,reason,status,current_step,calculation_status,next_step,created_by)
   SELECT gen_random_uuid(),'START_CALCULATION',t.id,tv.id,coalesce(t.notice_number,t.external_id),c.lot_key,c.company_id,'security',ev.id,r.evaluation_version,$3::uuid,
    concat('SECURITY_COST_CONFIG_RECALC:',$3::text,':',t.id,':',coalesce(c.lot_key,''),':',c.company_id),
    'AUTOMATIC_RECALCULATION_AFTER_COMPLETE_SECURITY_COST_CONFIGURATION','QUEUED','CALCULATION_QUEUED','CALCULATION_QUEUED','START_CALCULATION',$2
   FROM tender.calculations c JOIN tender.tenders t ON t.id=c.tender_id
   JOIN LATERAL(SELECT id FROM tender.tender_versions WHERE tender_id=t.id ORDER BY version DESC LIMIT 1)tv ON true
   JOIN LATERAL(SELECT id FROM tender.enrichment_versions WHERE tender_id=t.id ORDER BY version DESC LIMIT 1)ev ON true
   JOIN tender.current_service_relevance r ON r.tender_id=t.id AND r.company_id=c.company_id AND r.lot_key IS NOT DISTINCT FROM c.lot_key
   WHERE c.company_id=$1 AND c.service_line='security' AND c.status='CALCULATION_PARTIAL' AND t.offer_deadline>now()
    AND c.version=(SELECT max(x.version) FROM tender.calculations x WHERE x.tender_id=c.tender_id AND x.company_id=c.company_id AND x.lot_key IS NOT DISTINCT FROM c.lot_key)
   ON CONFLICT DO NOTHING`,[version.company_id,actorId,version.id]);
 }
 return changes;
};

export function registerConfigurationAdmin(app,{pool,requirePermission,csrf}){
 app.get("/api/configuration/catalog",{preHandler:requirePermission("tender.config.read")},async(req)=>{
  const companies=(await pool.query(`SELECT company_id,tender_profile_id,technical_key AS tender_company_key,legal_name,sector_slug,COALESCE(sector_slug,technical_key) AS configuration_service_line,
   discovery_status,matching_status,calculation_status,configuration_version,
   CASE WHEN legal_name='WB-Protect & Service GmbH' THEN true ELSE false END sector_locked
   FROM tender.enterprise_company_links ORDER BY legal_name`)).rows.filter(x=>scoped(req.identity,x.company_id));
  return {environment:"PRODUCTION",draftSource:true,minimumParameters,parameterCatalog:minimumParameters,companies,categories:["COMPANY_PROFILE","SERVICE_CPV","REGION_CAPACITY","EVIDENCE","CALCULATION","RISK_ECONOMICS"],currentUser:{id:req.identity.userId,email:req.identity.email,roles:req.identity.roles||[],permissions:req.identity.permissions,canSelfApproveActivate:hasExact(req.identity,SELF_APPROVE)}};
 });
 app.get("/api/configuration/status-blockers",{preHandler:requirePermission("tender.config.read")},async(req)=>{
  const companies=(await pool.query(`SELECT company_id FROM tender.enterprise_company_links ORDER BY legal_name`)).rows.filter(x=>scoped(req.identity,x.company_id));
  return readStatusBlockers(pool,companies,req.log);
 });
 app.get("/api/configuration/versions",{preHandler:requirePermission("tender.config.read")},async(req)=>({items:(await pool.query(`SELECT v.*,
  e.legal_name AS company_name,creator.email AS creator_email,approver.email AS approver_email,
  (SELECT count(*)::int FROM tender.configuration_changes c WHERE c.version_id=v.id) change_count,
  (SELECT c.parameter_key FROM tender.configuration_changes c WHERE c.version_id=v.id ORDER BY c.id LIMIT 1) parameter_key
  FROM tender.configuration_versions v LEFT JOIN tender.enterprise_company_links e ON e.company_id=v.company_id LEFT JOIN iam.users creator ON creator.id=v.created_by LEFT JOIN iam.users approver ON approver.id=v.approved_by ORDER BY version_no DESC LIMIT 200`)).rows.filter(x=>scoped(req.identity,x.company_id)).map(x=>({...x,parameter_tab:parameterByKey[x.parameter_key]?.category||null,parameter_tab_label:parameterByKey[x.parameter_key]?.tabLabel||null,actions:{details:true,submit:x.status==='DRAFT'&&x.created_by===req.identity.userId&&hasExact(req.identity,'tender.config.submit'),approve:x.status==='SUBMITTED'&&x.created_by!==req.identity.userId&&hasExact(req.identity,'tender.config.approve'),reject:x.status==='SUBMITTED'&&hasExact(req.identity,'tender.config.approve'),activate:x.status==='APPROVED'&&hasExact(req.identity,'tender.config.activate'),selfApproveActivate:x.status==='DRAFT'&&x.created_by===req.identity.userId&&hasExact(req.identity,SELF_APPROVE)}}))}));
 app.get("/api/configuration/versions/:id",{preHandler:requirePermission("tender.config.read")},async(req,reply)=>{
  const v=(await pool.query("SELECT * FROM tender.configuration_versions WHERE id=$1",[req.params.id])).rows[0];
  if(!v)return reply.code(404).send({error:"not_found"}); if(!requireScope(req,reply,v.company_id))return;
  const changes=(await pool.query("SELECT * FROM tender.configuration_changes WHERE version_id=$1 ORDER BY category,parameter_key",[v.id])).rows.map(x=>({...x,stored_unit:x.unit,unit:x.unit==="NOCH ZU PFLEGEN"?"NOCH ZU PFLEGEN (historischer Bestandswert)":units[x.unit]?.label||x.unit,unit_id:units[x.unit]?.id||null,historical_unit_placeholder:x.unit==="NOCH ZU PFLEGEN",canonical_category:parameterByKey[x.parameter_key]?.category||null,canonical_tab_label:parameterByKey[x.parameter_key]?.tabLabel||null}));
  return {...v,changes};
 });
 app.get("/api/configuration/parameter-state",{preHandler:requirePermission("tender.config.read")},async(req,reply)=>{
  const companyId=String(req.query?.companyId||""),serviceLine=String(req.query?.serviceLine||""),parameterKey=String(req.query?.parameterKey||"");
  if(!companyId||!serviceLine||!parameterByKey[parameterKey])return reply.code(422).send({error:"invalid_parameter_context"});
  if(!requireScope(req,reply,companyId))return;
  const row=(await pool.query(`SELECT v.id version_id,v.id draft_id,v.version_no,v.status,c.new_value,c.unit,c.source,c.data_as_of,c.valid_from,c.justification reason
   FROM tender.configuration_versions v JOIN tender.configuration_changes c ON c.version_id=v.id
   WHERE v.company_id=$1 AND v.service_line=$2 AND c.parameter_key=$3 AND v.status IN ('DRAFT','SUBMITTED','APPROVED','LOCKED')
   ORDER BY CASE v.status WHEN 'DRAFT' THEN 0 WHEN 'LOCKED' THEN 1 WHEN 'SUBMITTED' THEN 2 ELSE 3 END,v.version_no DESC LIMIT 1`,[companyId,serviceLine,parameterKey])).rows[0]
   ||(await pool.query(`SELECT v.id version_id,NULL::uuid draft_id,v.version_no,v.status,c.new_value,c.unit,c.source,c.data_as_of,c.valid_from,c.justification reason
   FROM tender.configuration_active_parameters a JOIN tender.configuration_versions v ON v.id=a.version_id JOIN tender.configuration_changes c ON c.id=a.change_id
   WHERE a.company_id=$1 AND a.service_line=$2 AND a.parameter_key=$3 LIMIT 1`,[companyId,serviceLine,parameterKey])).rows[0];
  if(!row)return {found:false,companyId,serviceLine,parameterKey};
  return {found:true,companyId,serviceLine,parameterKey,draftId:row.draft_id,versionId:row.version_id,versionNo:row.version_no,status:row.status,newValue:row.new_value,unit:row.unit,source:row.source,dataAsOf:row.data_as_of,validFrom:row.valid_from,reason:row.reason};
 });
 app.get("/api/configuration/security-cost-parameters",{preHandler:requirePermission("tender.config.read")},async(req,reply)=>{
  const companyId=String(req.query?.companyId||""),serviceLine=String(req.query?.serviceLine||"");if(!companyId||serviceLine!=="security")return reply.code(422).send({error:"invalid_security_cost_context"});if(!requireScope(req,reply,companyId))return;
  const rows=(await pool.query(`SELECT k.parameter_key,d.label,d.description,d.unit_label,a.activated_at,a.activated_by,u.email changed_by,c.new_value net_cost,c.valid_from,c.source,v.status,v.version_no,c.created_at changed_at,
   coalesce((SELECT jsonb_agg(jsonb_build_object('action',ca.action,'at',ca.occurred_at,'actorId',ca.actor_id,'actor',au.email,'metadata',ca.metadata) ORDER BY ca.occurred_at DESC) FROM tender.configuration_audit ca LEFT JOIN iam.users au ON au.id=ca.actor_id WHERE ca.version_id=v.id),'[]'::jsonb) audit_history
   FROM (VALUES ('S01'),('S02'),('S03'),('S04'))k(parameter_key)
   JOIN (VALUES
    ('S01','Videoanlage – Kostenansatz / Einheitspreis','Gesellschaftsscharf freigegebener Netto-Einheitspreis einer Videoanlage.','EUR/Einheit'),
    ('S02','Anlagenwoche – Kostenansatz / Einheitspreis','Gesellschaftsscharf freigegebener Netto-Kostenansatz je Anlagenwoche.','EUR/Woche'),
    ('S03','Notruf-/Servicewoche – Kostenansatz / Einheitspreis','Gesellschaftsscharf freigegebener Netto-Kostenansatz je Notruf- oder Servicewoche.','EUR/Woche'),
    ('S04','Baustellenausstattung – Kostenansatz / Einheitspreis','Gesellschaftsscharf freigegebener Netto-Kostenansatz für Baustellenausstattung.','EUR'))d(parameter_key,label,description,unit_label) USING(parameter_key)
   LEFT JOIN tender.configuration_active_parameters a ON a.company_id=$1 AND a.service_line=$2 AND a.parameter_key=k.parameter_key
   LEFT JOIN tender.configuration_changes c ON c.id=a.change_id LEFT JOIN tender.configuration_versions v ON v.id=a.version_id LEFT JOIN iam.users u ON u.id=a.activated_by
   ORDER BY k.parameter_key`,[companyId,serviceLine])).rows;
  return {companyId,serviceLine,complete:rows.every(x=>x.status==='ACTIVE'&&x.net_cost!==null),items:rows.map(x=>({...x,company_id:companyId,service_line:serviceLine,active:x.status==='ACTIVE',displayValue:x.net_cost===null?'Kostenansatz noch nicht hinterlegt':x.net_cost}))};
 });
 app.post("/api/configuration/drafts",{preHandler:[requirePermission(["tender.config.draft.edit",SELF_APPROVE]),csrf]},async(req,reply)=>{
  const b=normalizedInput(req.body||{}),errors=validateDraft(b);if(errors.length){const mapping=mappingError(b.parameterKey,b.category),message=b._unitError?.message||(b._numberInvalid?`Für ${b.parameterKey} ist ein gültiger Zahlenwert erforderlich.`:mapping?.message);return reply.code(422).send({error:"validation_failed",errors,...(message?{message}:{})})}
  if(!requireScope(req,reply,b.companyId))return;
  const right=EDIT_RIGHT[b.category];if(!right||(!can(req.identity,right)&&!hasExact(req.identity,SELF_APPROVE)))return reply.code(403).send({error:"category_forbidden"});
  const client=await pool.connect();
  try{
   await client.query("BEGIN");
   await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`${req.identity.userId}:${b.clientRequestId}`]);
   const existing=(await client.query(`SELECT v.id,v.version_no,v.status,v.created_at,c.id AS change_id,c.parameter_key
    FROM tender.configuration_versions v JOIN tender.configuration_changes c ON c.version_id=v.id
    WHERE v.created_by=$1 AND v.payload->>'clientRequestId'=$2 LIMIT 1`,[req.identity.userId,b.clientRequestId])).rows[0];
   if(existing){if(existing.parameter_key!==b.parameterKey){await client.query("ROLLBACK");return reply.code(409).send({error:"parameter_assignment_conflict",message:`Der geladene Entwurf gehört zu ${existing.parameter_key} – ${parameterByKey[existing.parameter_key]?.label||existing.parameter_key} und kann nicht als ${b.parameterKey} – ${parameterByKey[b.parameterKey]?.label||b.parameterKey} gespeichert werden.`})}await client.query("COMMIT");return reply.code(200).send({id:existing.id,versionNo:existing.version_no,status:existing.status,createdAt:existing.created_at,changeId:existing.change_id,parameterKey:existing.parameter_key,idempotent:true})}
   const company=(await client.query("SELECT legal_name,COALESCE(sector_slug,technical_key) AS configuration_service_line FROM tender.enterprise_company_links WHERE company_id=$1",[b.companyId])).rows[0];
   if(!company){await client.query("ROLLBACK");return reply.code(422).send({error:"validation_failed",errors:["companyId:company_unknown"]})}
   if(String(company.configuration_service_line||"").toLowerCase()!==String(b.serviceLine||"").toLowerCase()){await client.query("ROLLBACK");return reply.code(422).send({error:"validation_failed",errors:["serviceLine:service_line_mismatch"],message:"Der Leistungsbereich gehört nicht zur ausgewählten Gesellschaft."})}
   if(b.expectedDraftId||b.expectedVersionId){const expected=(await client.query(`SELECT v.id,v.version_no,v.company_id,v.service_line,c.parameter_key FROM tender.configuration_versions v JOIN tender.configuration_changes c ON c.version_id=v.id WHERE v.id=$1`,[b.expectedDraftId||b.expectedVersionId])).rows[0];if(!expected||expected.company_id!==b.companyId||expected.service_line!==b.serviceLine||expected.parameter_key!==b.parameterKey||b.expectedVersionNo&&Number(expected.version_no)!==Number(b.expectedVersionNo)){await client.query("ROLLBACK");const own=expected?.parameter_key?`${expected.parameter_key} – ${parameterByKey[expected.parameter_key]?.label||expected.parameter_key}`:"einem anderen Parameter";return reply.code(409).send({error:"parameter_assignment_conflict",message:`Der geladene Entwurf gehört zu ${own} und kann nicht als ${b.parameterKey} – ${parameterByKey[b.parameterKey]?.label||b.parameterKey} gespeichert werden.`})}}
   const predecessor=(await client.query(`SELECT id FROM tender.configuration_versions
    WHERE company_id IS NOT DISTINCT FROM $1 AND service_line IS NOT DISTINCT FROM $2
    ORDER BY version_no DESC LIMIT 1 FOR SHARE`,[b.companyId,b.serviceLine])).rows[0];
   if(b.expectedPredecessorId!==undefined&&(b.expectedPredecessorId||null)!==(predecessor?.id||null)){await client.query("ROLLBACK");return reply.code(409).send({error:"version_conflict"})}
   const locked=company.legal_name==="WB-Protect & Service GmbH",payload={clientRequestId:b.clientRequestId,companyId:b.companyId,serviceLine:b.serviceLine,source:String(b.source),reason:String(b.reason)};
   const version=(await client.query(`INSERT INTO tender.configuration_versions(predecessor_id,company_id,service_line,source,reason,payload,checksum,created_by,status,locked_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[predecessor?.id||null,b.companyId,b.serviceLine,String(b.source),String(b.reason),payload,checksum(payload),req.identity.userId,locked?"LOCKED":"DRAFT",locked?new Date():null])).rows[0];
   const change=(await client.query(`INSERT INTO tender.configuration_changes(version_id,category,parameter_key,old_value,new_value,unit,source,data_as_of,valid_from,valid_until,priority,complete,justification)
    VALUES($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10,false,$11) RETURNING *`,[version.id,b.category,b.parameterKey,JSON.stringify(b.newValue),String(b.unit),String(b.source),b.dataAsOf||null,b.validFrom,b.validUntil||null,b.parameterKey[0],String(b.reason)])).rows[0];
   await client.query("INSERT INTO tender.configuration_audit(version_id,actor_id,action,metadata) VALUES($1,$2,'DRAFT_CREATED',$3),($1,$2,'CHANGE_SAVED',$4)",[version.id,req.identity.userId,{clientRequestId:b.clientRequestId,companyId:b.companyId,serviceLine:b.serviceLine},{parameterKey:b.parameterKey,category:b.category}]);
   await client.query("COMMIT");
   return reply.code(201).send({id:version.id,versionNo:version.version_no,status:version.status,createdAt:version.created_at,changeId:change.id,parameterKey:change.parameter_key,unitId:change.unit,unitLabel:units[change.unit]?.label||change.unit,newValue:change.new_value});
  }catch(error){try{await client.query("ROLLBACK")}catch{}req.log.error({err:error},"atomic draft save failed");return reply.code(500).send({error:"draft_save_failed"})}finally{client.release()}
 });
 app.post("/api/configuration/versions",{preHandler:[requirePermission("tender.config.draft.edit"),csrf]},async(req,reply)=>{
  const b=req.body||{}; if(!requireScope(req,reply,b.companyId))return;
  const locked=b.companyId&&(await pool.query("SELECT legal_name FROM tender.enterprise_company_links WHERE company_id=$1",[b.companyId])).rows[0]?.legal_name==='WB-Protect & Service GmbH';
  const payload={companyId:b.companyId||null,serviceLine:b.serviceLine||null,source:String(b.source||''),reason:String(b.reason||'')};
  if(!payload.source||!payload.reason)return reply.code(400).send({error:"source_and_reason_required"});
  const r=await pool.query(`INSERT INTO tender.configuration_versions(predecessor_id,company_id,service_line,source,reason,payload,checksum,created_by,status,locked_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[b.predecessorId||null,payload.companyId,payload.serviceLine,payload.source,payload.reason,payload,checksum(payload),req.identity.userId,locked?'LOCKED':'DRAFT',locked?new Date():null]);
  await pool.query("INSERT INTO tender.configuration_audit(version_id,actor_id,action) VALUES($1,$2,'DRAFT_CREATED')",[r.rows[0].id,req.identity.userId]); return reply.code(201).send(r.rows[0]);
 });
 app.post("/api/configuration/versions/:id/changes",{preHandler:[requirePermission("tender.config.draft.edit"),csrf]},async(req,reply)=>{
  const v=(await pool.query("SELECT * FROM tender.configuration_versions WHERE id=$1",[req.params.id])).rows[0]; if(!v)return reply.code(404).send({error:"not_found"});
  if(!requireScope(req,reply,v.company_id))return;if(v.status!=="DRAFT")return reply.code(409).send({error:"version_not_editable"});
  const b=normalizedInput(req.body||{}),mapping=mappingError(b.parameterKey,b.category);if(mapping)return reply.code(422).send({error:"validation_failed",errors:[`parameterKey:${mapping.code}`],message:mapping.message});const right=EDIT_RIGHT[b.category];if(!right||!can(req.identity,right))return reply.code(403).send({error:"category_forbidden"});
  const errors=validateChange(b);if(errors.length)return reply.code(422).send({error:"validation_failed",errors,message:b._unitError?.message||(b._numberInvalid?`Für ${b.parameterKey} ist ein gültiger Zahlenwert erforderlich.`:undefined)});
  const r=await pool.query(`INSERT INTO tender.configuration_changes(version_id,category,parameter_key,old_value,new_value,unit,source,data_as_of,valid_from,valid_until,priority,complete,justification)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(version_id,category,parameter_key) DO UPDATE SET
   new_value=excluded.new_value,unit=excluded.unit,source=excluded.source,data_as_of=excluded.data_as_of,valid_from=excluded.valid_from,valid_until=excluded.valid_until,priority=excluded.priority,complete=excluded.complete,justification=excluded.justification RETURNING *`,
   [v.id,b.category,b.parameterKey,b.oldValue===undefined?null:JSON.stringify(b.oldValue),JSON.stringify(b.newValue),b.unit||null,b.source,b.dataAsOf||null,b.validFrom,b.validUntil||null,b.priority||null,b.complete===true,b.justification||'Fachliche Pflege']);
  await pool.query("INSERT INTO tender.configuration_audit(version_id,actor_id,action,metadata) VALUES($1,$2,'CHANGE_SAVED',$3)",[v.id,req.identity.userId,{parameterKey:b.parameterKey}]);return r.rows[0];
 });
 app.post("/api/configuration/versions/:id/validate",{preHandler:[requirePermission("tender.config.draft.edit"),csrf]},async(req,reply)=>{
  const v=(await pool.query("SELECT * FROM tender.configuration_versions WHERE id=$1",[req.params.id])).rows[0];if(!v)return reply.code(404).send({error:"not_found"});if(!requireScope(req,reply,v.company_id))return;
  const changes=(await pool.query("SELECT * FROM tender.configuration_changes WHERE version_id=$1",[v.id])).rows;
  const errors=[];if(!changes.length)errors.push("at_least_one_change_required");for(const x of changes)errors.push(...validateChange({category:x.category,parameterKey:x.parameter_key,newValue:x.new_value,unit:x.unit,source:x.source,validFrom:x.valid_from,validUntil:x.valid_until}).map(e=>`${x.parameter_key}:${e}`));
  const validation={valid:!errors.length,errors,checkedAt:new Date().toISOString()};await pool.query("UPDATE tender.configuration_versions SET validation=$2,status=$3 WHERE id=$1",[v.id,validation,errors.length?'VALIDATION_FAILED':'DRAFT']);return validation;
 });
 app.post("/api/configuration/versions/:id/preview",{preHandler:[requirePermission("tender.config.preview"),csrf]},async(req,reply)=>{
  const v=(await pool.query("SELECT * FROM tender.configuration_versions WHERE id=$1",[req.params.id])).rows[0];if(!v)return reply.code(404).send({error:"not_found"});if(!requireScope(req,reply,v.company_id))return;
  const tenders=(await pool.query(`SELECT t.id,t.title,t.company_id,d.weighted_score old_score,d.hard_gate_result old_hard_gates,d.recommendation old_decision
   FROM tender.tenders t LEFT JOIN LATERAL(SELECT * FROM tender.decisions d WHERE d.tender_id=t.id ORDER BY version DESC LIMIT 1)d ON true
   WHERE ($1::uuid IS NULL OR t.company_id=$1) ORDER BY t.updated_at DESC LIMIT 100`,[v.company_id])).rows;
  const preview={isolated:true,persistedTenderChanges:0,affectedCount:tenders.length,tenders:tenders.map(t=>({...t,new_company_id:t.company_id,new_score:t.old_score,new_hard_gates:t.old_hard_gates,new_decision:t.old_decision,warnings:["Simulation – keine produktive Bewertung überschrieben"]})),conflicts:[]};
  await pool.query("UPDATE tender.configuration_versions SET impact_preview=$2 WHERE id=$1",[v.id,preview]);return preview;
 });
 const transition=(path,permission,from,to,stamp)=>app.post(path,{preHandler:[requirePermission(permission),csrf]},async(req,reply)=>{
  const client=await pool.connect();try{await client.query('BEGIN');const v=(await client.query("SELECT * FROM tender.configuration_versions WHERE id=$1 FOR UPDATE",[req.params.id])).rows[0];if(!v){await client.query('ROLLBACK');return reply.code(404).send({error:'not_found'})}if(!requireScope(req,reply,v.company_id)){await client.query('ROLLBACK');return}if(!from.includes(v.status)){await client.query('ROLLBACK');return reply.code(409).send({error:'stale_or_invalid_state',current:v.status})}
   if(to==='SUBMITTED'&&v.validation?.valid!==true){await client.query('ROLLBACK');return reply.code(422).send({error:'validation_required'})}if(to==='APPROVED'&&req.identity.userId===v.created_by){await client.query('ROLLBACK');return reply.code(403).send({error:'four_eyes_required'})}
   const set=stamp?`,${stamp}=now()`:'';const actor=to==='APPROVED'?`,approved_by=$3`:'';const args=to==='APPROVED'?[v.id,to,req.identity.userId]:[v.id,to];await client.query(`UPDATE tender.configuration_versions SET status=$2${set}${actor} WHERE id=$1`,args);await client.query("INSERT INTO tender.configuration_audit(version_id,actor_id,action,metadata) VALUES($1,$2,$3,$4)",[v.id,req.identity.userId,to,{reason:req.body?.reason||null}]);await client.query('COMMIT');return {ok:true,status:to};
  }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}});
 transition("/api/configuration/versions/:id/submit","tender.config.submit",["DRAFT"],"SUBMITTED","submitted_at");
 transition("/api/configuration/versions/:id/approve","tender.config.approve",["SUBMITTED"],"APPROVED","approved_at");
 transition("/api/configuration/versions/:id/reject","tender.config.approve",["SUBMITTED"],"REJECTED",null);
 app.post("/api/configuration/versions/:id/activate",{preHandler:[requirePermission("tender.config.activate"),csrf]},async(req,reply)=>{const c=await pool.connect();try{await c.query('BEGIN');const v=(await c.query("SELECT * FROM tender.configuration_versions WHERE id=$1 FOR UPDATE",[req.params.id])).rows[0];if(!v||!requireScope(req,reply,v?.company_id)){await c.query('ROLLBACK');return}if(v.status==="ACTIVE"){const statusReadModel=await readStatusBlockers(c,[{company_id:v.company_id}],req.log);await c.query('COMMIT');return{ok:true,idempotent:true,status:'ACTIVE',statusReadModel:statusReadModel.companies[0]}}if(v.status!=="APPROVED"||!v.impact_preview?.isolated){await c.query('ROLLBACK');return reply.code(422).send({error:"approval_and_preview_required"})}await activateParameters(c,v,req.identity.userId);const statusReadModel=await readStatusBlockers(c,[{company_id:v.company_id}],req.log);await c.query("INSERT INTO tender.configuration_audit(version_id,actor_id,action) VALUES($1,$2,'ACTIVE')",[v.id,req.identity.userId]);await c.query('COMMIT');return{ok:true,status:'ACTIVE',statusReadModel:statusReadModel.companies[0]}}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}});
 app.post("/api/configuration/versions/:id/self-approve-activate",{preHandler:[requirePermission(SELF_APPROVE),csrf]},async(req,reply)=>{
  if(!hasExact(req.identity,SELF_APPROVE))return reply.code(403).send({error:"self_approval_forbidden",message:germanActionError.permission});
  const c=await pool.connect();try{await c.query("BEGIN");await c.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`self-activate:${req.params.id}`]);
   const v=(await c.query(`SELECT v.*,e.legal_name,u.email creator_email FROM tender.configuration_versions v LEFT JOIN tender.enterprise_company_links e ON e.company_id=v.company_id LEFT JOIN iam.users u ON u.id=v.created_by WHERE v.id=$1 FOR UPDATE OF v`,[req.params.id])).rows[0];
   if(!v){await c.query("ROLLBACK");return reply.code(404).send({error:"not_found"})}
   if(v.status==="ACTIVE"&&v.approved_by===req.identity.userId){await c.query("COMMIT");return {ok:true,idempotent:true,status:"ACTIVE",versionNo:v.version_no,message:`Version ${v.version_no} wurde durch den Vorstand freigegeben und aktiviert.`}}
   if(!scoped(req.identity,v.company_id)){await c.query("ROLLBACK");return reply.code(403).send({error:"company_scope_forbidden",message:germanActionError.scope})}
   if(v.created_by!==req.identity.userId){await c.query("ROLLBACK");return reply.code(403).send({error:"self_approval_owner_required",message:germanActionError.owner})}
   const onlyChange=(await c.query("SELECT parameter_key FROM tender.configuration_changes WHERE version_id=$1 ORDER BY id",[v.id])).rows;if(req.body?.expectedParameterKey&&(!onlyChange.length||onlyChange.some(x=>x.parameter_key!==req.body.expectedParameterKey))){await c.query("ROLLBACK");const own=onlyChange[0]?.parameter_key||"einem anderen Parameter";return reply.code(409).send({error:"parameter_assignment_conflict",message:`Der geladene Entwurf gehört zu ${own}${parameterByKey[own]?.label?` – ${parameterByKey[own].label}`:""} und kann nicht als ${req.body.expectedParameterKey} – ${parameterByKey[req.body.expectedParameterKey]?.label||req.body.expectedParameterKey} gespeichert werden.`})}if(v.status!=="DRAFT"||Number(req.body?.expectedVersionNo)!==Number(v.version_no)){await c.query("ROLLBACK");return reply.code(409).send({error:"version_conflict",current:v.status,message:germanActionError.state})}
   const company=(await c.query("SELECT legal_name,COALESCE(sector_slug,technical_key) configuration_service_line FROM tender.enterprise_company_links WHERE company_id=$1",[v.company_id])).rows[0];
   if(!company||String(company.configuration_service_line).toLowerCase()!==String(v.service_line).toLowerCase()){await c.query("ROLLBACK");return reply.code(422).send({error:"company_service_mismatch",message:germanActionError.validation})}
   const changes=(await c.query("SELECT * FROM tender.configuration_changes WHERE version_id=$1 ORDER BY id",[v.id])).rows;const errors=[];
   if(!changes.length)errors.push("at_least_one_change_required");for(const x of changes)errors.push(...validateChange({category:x.category,parameterKey:x.parameter_key,newValue:x.new_value,unit:x.unit,source:x.source,validFrom:x.valid_from,validUntil:x.valid_until}).map(e=>`${x.parameter_key}:${e}`));
   if(errors.length){await c.query("ROLLBACK");return reply.code(422).send({error:"validation_failed",errors,message:germanActionError.validation})}
   const preview={isolated:true,persistedTenderChanges:0,affectedCount:changes.length,generatedAt:new Date().toISOString(),parameters:changes.map(x=>x.parameter_key),conflicts:[]};
   await c.query("UPDATE tender.configuration_versions SET status='APPROVED',validation=$2,impact_preview=$3,submitted_at=now(),approved_at=now(),approved_by=$4 WHERE id=$1 AND status='DRAFT'",[v.id,{valid:true,errors:[],checkedAt:new Date().toISOString()},preview,req.identity.userId]);
   await activateParameters(c,v,req.identity.userId);
   const activated=(await c.query("SELECT * FROM tender.configuration_versions WHERE id=$1",[v.id])).rows[0];
   const role=(req.identity.roles||[]).join(", ");const metadata={notice:"Selbstfreigabe aufgrund ausdrücklicher Vorstandsberechtigung",creatorId:v.created_by,creator:v.creator_email,approverId:req.identity.userId,activatorId:req.identity.userId,actorRole:role,companyId:v.company_id,company:company.legal_name,serviceLine:v.service_line,versionNo:v.version_no,parameters:changes.map(x=>({parameterKey:x.parameter_key,oldValue:x.old_value,newValue:x.new_value,unit:x.unit,source:x.source,reason:x.justification||v.reason}))};
   const statusReadModel=await readStatusBlockers(c,[{company_id:v.company_id}],req.log);await c.query("INSERT INTO tender.configuration_audit(version_id,actor_id,action,metadata) VALUES($1,$2,'BOARD_SELF_APPROVED',$3),($1,$2,'ACTIVE',$3)",[v.id,req.identity.userId,metadata]);await c.query("COMMIT");
   return {ok:true,status:"ACTIVE",versionNo:activated.version_no,company:company.legal_name,companyId:v.company_id,serviceLine:v.service_line,parameters:changes.map(x=>x.parameter_key),activatedAt:activated.activated_at,approverActivator:req.identity.email,statusReadModel:statusReadModel.companies[0],message:`Version ${activated.version_no} wurde durch den Vorstand freigegeben und aktiviert.`};
  }catch(e){try{await c.query("ROLLBACK")}catch{}req.log.error({err:e},"atomic board self approval failed");return reply.code(500).send({error:"board_activation_failed",message:"Die Vorstandsfreigabe konnte nicht atomar abgeschlossen werden; der Entwurf blieb unverändert."})}finally{c.release()}
 });
 app.post("/api/configuration/versions/:id/rollback",{preHandler:[requirePermission("tender.config.rollback"),csrf]},async(req,reply)=>{const old=(await pool.query("SELECT * FROM tender.configuration_versions WHERE id=$1",[req.params.id])).rows[0];if(!old)return reply.code(404).send({error:'not_found'});if(!requireScope(req,reply,old.company_id))return;const payload={...old.payload,rollbackOf:old.id};const r=await pool.query(`INSERT INTO tender.configuration_versions(predecessor_id,company_id,service_line,source,reason,payload,checksum,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[old.id,old.company_id,old.service_line,old.source,req.body?.reason||'Rücksetzversion',payload,checksum(payload),req.identity.userId]);await pool.query(`INSERT INTO tender.configuration_changes(version_id,category,parameter_key,old_value,new_value,unit,source,data_as_of,valid_from,valid_until,priority,complete,justification) SELECT $1,category,parameter_key,new_value,old_value,unit,source,data_as_of,valid_from,valid_until,priority,complete,$2 FROM tender.configuration_changes WHERE version_id=$3`,[r.rows[0].id,req.body?.reason||'Rücksetzversion',old.id]);return reply.code(201).send(r.rows[0])});
 app.get("/api/configuration/audit",{preHandler:requirePermission("tender.config.audit.read")},async()=>({items:(await pool.query("SELECT * FROM tender.configuration_audit ORDER BY id DESC LIMIT 500")).rows}));
}
