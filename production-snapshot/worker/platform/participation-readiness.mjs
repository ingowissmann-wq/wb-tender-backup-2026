const step = (number, title, status, result, evidence, next, versions = {}) => ({ number, title, status, result, evidence, next, versions });
const complete = (condition) => condition ? "COMPLETE" : "BLOCKED";

export function buildParticipationReadiness(input, generatedAt = new Date().toISOString()) {
  const tender = input.tender || {}, lot = input.lotLifecycle || null;
  const eligible = tender.source_lifecycle_status === "ACTIVE"
    && ["ELIGIBLE","PARTIALLY_ELIGIBLE"].includes(tender.participation_status)
    && Boolean(input.lotKey) && lot?.lifecycle_status === "ACTIVE" && lot?.participation_status === "ELIGIBLE" && lot?.deadline_quality === "EXACT"
    && Boolean(lot?.offer_deadline) && new Date(lot.offer_deadline) > new Date(generatedAt);
  const portal = input.portal || null, credential = input.credential || null, documents = input.documents || {};
  const analyzed = Number(documents.analyzed || 0), downloaded = Number(documents.downloaded || 0), clean = Number(documents.clean || 0);
  const requirements = input.requirements || {}, profile = input.profile || null, calculation = input.calculation || null;
  const management = input.management || null, approval = input.approval || null, bidPackage = input.bidPackage || null;
  const portalStatus = portal?.mapping_status === "MANUAL_CONFIRMED" ? "MANUAL_PORTAL_CONFIRMED" : portal?.id ? "EXACT_PORTAL_MATCH" : input.portalCandidates > 1 ? "MULTIPLE_PORTALS_REVIEW_REQUIRED" : "PORTAL_NOT_FOUND";
  const versions = { tenderVersion: input.tenderVersion || null, profileVersion: profile?.version || null, credentialVersion: credential?.version || null, calculationVersion: calculation?.version || null };
  const steps = [
    step(1,"Ausschreibung und Los prüfen",eligible?"COMPLETE":"BLOCKED",eligible?"Offenes Los mit eindeutiger autoritativer Frist":lot?.participation_block_reason||tender.participation_block_reason||"Konkretes teilnahmefähiges Los erforderlich",{noticeClassification:tender.notice_classification,deadline:lot?.offer_deadline||null,lot:input.lotKey||null,deadlineQuality:lot?.deadline_quality||null},eligible?"Gesellschaft und Gewerk prüfen":"Zur Verfahrenshistorie",versions),
    step(2,"Gesellschaft und Gewerk prüfen",complete(Boolean(input.company&&input.serviceLine)),input.company?input.company.name:"Gesellschaftskontext fehlt",{companyId:input.company?.id||null,serviceLine:input.serviceLine||null},input.company?"Region und Frist prüfen":"Gesellschaft auswählen",versions),
    step(3,"Region und Frist prüfen",complete(eligible&&Boolean(input.region)),input.region?.status||"Regionsprüfung offen",{regionVersion:input.region?.version||null,deadline:lot?.offer_deadline||null,lot:input.lotKey||null},input.region?"Teilnahmeportal ermitteln":"Region prüfen",versions),
    step(4,"Tatsächliches Teilnahme-/Abgabeportal ermitteln",portal?"COMPLETE":"BLOCKED",portalStatus,{publicationPlatform:tender.source_code,portalId:portal?.id||null,host:portal?.host||null,capability:portal?.capability||null},portal?"Portalzugang prüfen":"Teilnahmeportal suchen und auswählen",versions),
    step(5,"Registrierung beziehungsweise Portalzugang prüfen",portal?complete(Boolean(credential)):"BLOCKED",credential?"Gesellschaftsgebundener Zugang vorhanden":"Kein geeigneter Zugang hinterlegt",{credentialId:credential?.id||null,credentialVersion:credential?.version||null,accountType:credential?.account_type||null},credential?"Vergabeunterlagen abrufen":"Zugang verwalten oder offizielle Registrierung öffnen",versions),
    step(6,"Vergabeunterlagen herunterladen",complete(downloaded>0&&clean===downloaded),downloaded?`${downloaded} Unterlagen geladen`:(documents.started?"Abruf läuft oder erfordert Prüfung":"Noch nicht gestartet"),{found:Number(documents.found||0),downloaded,malwareClean:clean},downloaded?"Dokumente analysieren":"Vergabeunterlagen abrufen",versions),
    step(7,"Dokumente prüfen und analysieren",complete(analyzed>0&&analyzed>=downloaded),analyzed?`${analyzed} Unterlagen analysiert`:"Analyse ausstehend",{analyzed,downloaded},analyzed?"Anforderungen prüfen":"Dokumentenanalyse starten",versions),
    step(8,"Anforderungen und Nachweise bestimmen",complete(requirements.total>0&&requirements.open===0),requirements.total?`${requirements.open} von ${requirements.total} Anforderungen offen`:"Noch keine belastbare Anforderungsmatrix",{total:Number(requirements.total||0),open:Number(requirements.open||0)},requirements.open?"Offene Nachweise bearbeiten":"Gesellschaftsprofil prüfen",versions),
    step(9,"Gesellschaftsprofil prüfen",complete(profile?.release_ready===true),profile?.release_ready?"Aktuelle Profilversion freigabefähig":"Profilwerte oder autoritative Quellen fehlen",{profileId:profile?.id||null,version:profile?.version||null,completeness:profile?.completeness||null},profile?.release_ready?"Kalkulation erstellen":"Gesellschaftsprofil vervollständigen",versions),
    step(10,"Kalkulation erstellen",complete(Boolean(calculation&&["CALCULATED","CALCULATION_COMPLETED"].includes(calculation.status))),calculation?.status||"Kalkulation nicht erstellt",{calculationId:calculation?.id||null,version:calculation?.version||null,missing:calculation?.blocked_reasons||[]},calculation?"Managementvorlage erzeugen":"Fehlende Eingaben ergänzen",versions),
    step(11,"Managementvorlage erzeugen",complete(Boolean(management)),management?.status||"Managementvorlage fehlt",{managementOutputId:management?.id||null},management?"Freigabe einholen":"Managementvorlage erzeugen",versions),
    step(12,"Freigabe einholen",complete(approval?.status==="APPROVED"),approval?.status||"Keine Freigabe",{approvalId:approval?.id||null,expiresAt:approval?.expires_at||null},approval?.status==="APPROVED"?"Angebotspaket vorbereiten":"Managemententscheidung erforderlich",versions),
    step(13,"Angebotspaket vorbereiten",complete(Boolean(bidPackage)),bidPackage?.status||"Angebotspaket fehlt",{packageId:bidPackage?.id||null,fingerprint:bidPackage?.manifest_sha256||null},bidPackage?"Abgabe-Gate prüfen":"Angebotspaket erzeugen",versions),
    step(14,"Abgabe-Gate prüfen","BLOCKED","Externe Abgabe ist systemweit gesperrt",{httpStatus:423,externalSubmission:false},"Separate Go-live-Freigabe erforderlich",versions),
  ];
  return { tenderId:tender.id, companyId:input.company?.id||null, lotKey:input.lotKey||null, eligible, publicationPlatform:tender.source_code||null, participationPortal:portal, portalStatus, generatedAt, externalSubmission:false, externalSubmissionHttpStatus:423, steps };
}
