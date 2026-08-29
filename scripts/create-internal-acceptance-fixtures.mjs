import crypto from "node:crypto";
import fs from "node:fs";
import pg from "pg";

const connectionString=process.env.DATABASE_URL||fs.readFileSync(process.env.DATABASE_URL_FILE||"/run/secrets/database_url","utf8").trim();
const pool=new pg.Pool({connectionString});
const stable=value=>JSON.stringify(value&&typeof value==="object"?(Array.isArray(value)?value.map(item=>JSON.parse(stable(item))):Object.fromEntries(Object.keys(value).sort().map(key=>[key,JSON.parse(stable(value[key]))]))):value??null);
const sha=value=>crypto.createHash("sha256").update(typeof value==="string"?value:stable(value)).digest("hex");

const fixtures=[{
  fixtureKey:"INTERNAL_ACCEPTANCE_SECURITY_COMPLETE",serviceArea:"security",company:"WB-Security GmbH",cpvCodes:["79713000"],title:"INTERNAL ACCEPTANCE – vollständiger Security-Kalkulationsfall",description:"Intern kontrollierter Abnahmefall für Bewachungsdienste, Objektschutz, Pfortendienst und Schließdienst.",
  scope:{main_service:"Bewachungsdienste und Objektschutz",object_count:2,sites:["Interner Teststandort Nord","Interner Teststandort Süd"],posts:3,staffing_strength:4,workdays:["Montag-Freitag","Samstag","Sonntag"],service_times:["Montag-Freitag 18:00-06:00","Samstag-Sonntag 00:00-24:00"],guarding_times:["24/7 Kontroll- und Schließdienst"],productive_hours:17520,night_hours:5840,sunday_hours:2500,holiday_hours:288,qualifications:["§34a Sachkunde","GSSK"],site_management:"0,50 FTE Objektleitung",operations_management:"0,25 FTE Einsatzleitung",materials:["Kontrollbücher","Verbrauchsmaterial"],equipment:["Wächterkontrollsystem","Funkgeräte"],vehicles:["1 Revierfahrzeug"],price_positions:["SEC-01 Pfortendienst","SEC-02 Schließdienst","SEC-03 Revierdienst"]}
},{
  fixtureKey:"INTERNAL_ACCEPTANCE_CLEANING_COMPLETE",serviceArea:"cleaning",company:"WB-Cleaning GmbH",cpvCodes:["90911200"],title:"INTERNAL ACCEPTANCE – vollständiger Cleaning-Kalkulationsfall",description:"Intern kontrollierter Abnahmefall für Unterhalts-, Glas- und Sonderreinigung.",
  scope:{main_service:"Unterhaltsreinigung und Glasreinigung",object_count:2,sites:["Internes Testobjekt Verwaltung","Internes Testobjekt Betrieb"],areas:12500,room_groups:["Büro 6000 m²","Sanitär 1500 m²","Verkehr 3500 m²","Nebenflächen 1500 m²"],cleaning_types:["Unterhaltsreinigung","Glasreinigung","Sonderreinigung"],cleaning_intervals:["Büro 5x wöchentlich","Sanitär täglich","Verkehr 5x wöchentlich"],service_frequencies:["Montag-Freitag"],workdays:["Montag-Freitag"],service_times:["05:00-09:00","17:00-21:00"],productive_hours:11250,performance_values:["Büro 250 m²/h","Sanitär 100 m²/h","Verkehr 350 m²/h"],glass_areas:1800,special_services:["Grundreinigung jährlich"],materials:["Reinigungschemie","Verbrauchsmaterial"],machines:["Scheuersaugmaschine","Einscheibenmaschine"],vehicles:["1 Servicefahrzeug"],site_management:"0,60 FTE Objektleitung",price_positions:["CLN-01 Unterhaltsreinigung","CLN-02 Glasreinigung","CLN-03 Sonderreinigung"]}
}];

const client=await pool.connect();
try{
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('wb-internal-acceptance-fixtures'))");
  const created=[];
  for(const definition of fixtures){
    const company=(await client.query("SELECT company_id FROM tender.enterprise_company_links WHERE legal_name=$1 AND sector_slug=$2 AND active=true",[definition.company,definition.serviceArea])).rows[0];
    if(!company)throw new Error(`active_company_missing:${definition.company}`);
    const manifest={classification:"INTERNAL_ACCEPTANCE_FIXTURE",fixtureKey:definition.fixtureKey,title:definition.title,description:definition.description,buyer:"WB Holding – interne technische Abnahme",cpvCodes:definition.cpvCodes,nuts:["DE212"],offerDeadline:"2026-09-30T12:00:00Z",questionDeadline:"2026-09-15T12:00:00Z",contractStart:"2027-01-01",contractEnd:"2028-12-31",duration:24,awardCriteria:[{criterion:"Preis",weight:60},{criterion:"Qualität",weight:40}],scope:definition.scope,transmitted:false,externalActionsEnabled:false};
    const manifestHash=sha(manifest),rawHash=sha(`${definition.fixtureKey}:${manifestHash}`);
    let tender=(await client.query("SELECT * FROM tender.tenders WHERE source_code='INTERNAL_ACCEPTANCE' AND external_id=$1 FOR UPDATE",[definition.fixtureKey])).rows[0];
    if(!tender)tender=(await client.query(`INSERT INTO tender.tenders(data_class,source_code,external_id,notice_number,buyer,title,description,cpv_codes,regions,company_id,publication_date,offer_deadline,contract_start,contract_end,duration_months,currency,source_url,source_timestamp,status,raw_sha256)
      VALUES('INTERNAL_ACCEPTANCE_FIXTURE','INTERNAL_ACCEPTANCE',$1,$1,$2,$3,$4,$5,$6,$7,current_date,$8,$9,$10,24,'EUR',$11,now(),'ACTIVE',$12) RETURNING *`,[definition.fixtureKey,manifest.buyer,definition.title,definition.description,definition.cpvCodes,manifest.nuts,company.company_id,manifest.offerDeadline,manifest.contractStart,manifest.contractEnd,`internal-acceptance://${definition.fixtureKey}`,rawHash])).rows[0];
    await client.query(`INSERT INTO tender.internal_acceptance_fixtures(fixture_key,tender_id,company_id,service_area,manifest,manifest_sha256)
      VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT(fixture_key) DO UPDATE SET manifest=excluded.manifest,manifest_sha256=excluded.manifest_sha256,company_id=excluded.company_id,service_area=excluded.service_area`,[definition.fixtureKey,tender.id,company.company_id,definition.serviceArea,stable(manifest),manifestHash]);
    let version=(await client.query("SELECT * FROM tender.tender_versions WHERE tender_id=$1 AND source_sha256=$2",[tender.id,manifestHash])).rows[0];
    if(!version)version=(await client.query("INSERT INTO tender.tender_versions(tender_id,version,source_sha256,normalized_data,change_kind,source_timestamp) SELECT $1,coalesce(max(version),0)+1,$2,$3::jsonb,CASE WHEN count(*)=0 THEN 'INITIAL' ELSE 'UPDATED' END,now() FROM tender.tender_versions WHERE tender_id=$1 RETURNING *",[tender.id,manifestHash,stable(manifest)])).rows[0];
    const lot=(await client.query(`INSERT INTO tender.lots(tender_id,external_id,title,deadline)
      VALUES($1,'LOT-ACCEPTANCE-001',$2,$3)
      ON CONFLICT(tender_id,external_id) WHERE external_id IS NOT NULL DO UPDATE
      SET title=excluded.title,deadline=excluded.deadline RETURNING id`,[tender.id,definition.title,manifest.offerDeadline])).rows[0];
    await client.query(`INSERT INTO tender.tender_lot_lifecycles(tender_id,lot_key,lifecycle_status,participation_status,offer_deadline,deadline_quality,is_current)
      VALUES($1,'LOT-ACCEPTANCE-001',CASE WHEN $2::timestamptz>now() THEN 'ACTIVE' ELSE 'EXPIRED' END,
        CASE WHEN $2::timestamptz>now() THEN 'ELIGIBLE' ELSE 'NOT_ELIGIBLE' END,$2,'EXACT',true)
      ON CONFLICT(tender_id,lot_key) DO UPDATE SET lifecycle_status=excluded.lifecycle_status,participation_status=excluded.participation_status,
        participation_block_reason=NULL,offer_deadline=excluded.offer_deadline,deadline_quality='EXACT',is_current=true,updated_at=now()`,[tender.id,manifest.offerDeadline]);
    const key=["RUN_FULL_PIPELINE",tender.id,"LOT-ACCEPTANCE-001",company.company_id,manifestHash,"acceptance-v1"].join(":");
    const job=(await client.query(`INSERT INTO tender.autopilot_queue(request_id,action_type,tender_id,tender_version_id,notice_id,lot_id,lot_key,company_id,service_scope,reason,status,current_step,idempotency_key,max_attempts)
      VALUES(gen_random_uuid(),'RUN_FULL_PIPELINE',$1,$2,$3,$4,'LOT-ACCEPTANCE-001',$5,$6,$7,'QUEUED','DISCOVERED',$8,3)
      ON CONFLICT(idempotency_key) WHERE status IN ('PENDING','CLAIMED','RETRY','QUEUED','RUNNING') DO UPDATE SET idempotency_key=excluded.idempotency_key RETURNING id,status`,[tender.id,version.id,definition.fixtureKey,lot.id,company.company_id,definition.serviceArea,`INTERNAL_ACCEPTANCE_FIXTURE:${definition.fixtureKey}`,key])).rows[0];
    await client.query("INSERT INTO tender.audit_events(action,tender_id,metadata) VALUES('internal_acceptance_fixture_created',$1,$2::jsonb)",[tender.id,stable({fixtureKey:definition.fixtureKey,classification:"INTERNAL_ACCEPTANCE_FIXTURE",manifestSha256:manifestHash,companyId:company.company_id,serviceArea:definition.serviceArea,externalWrite:false,transmitted:false})]);
    created.push({fixtureKey:definition.fixtureKey,tenderId:tender.id,companyId:company.company_id,serviceArea:definition.serviceArea,manifestSha256:manifestHash,jobId:job.id,jobStatus:job.status});
  }
  if((await client.query("SELECT count(*)::int n FROM tender.internal_acceptance_fixtures")).rows[0].n!==2)throw new Error("fixture_count_not_exactly_two");
  await client.query("COMMIT");
  console.log(JSON.stringify({created,classification:"INTERNAL_ACCEPTANCE_FIXTURE",externalTransmission:false}));
}catch(error){await client.query("ROLLBACK");throw error}finally{client.release();await pool.end()}
