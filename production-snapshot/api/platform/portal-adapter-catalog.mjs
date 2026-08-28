import {PORTAL_ADAPTER_CONTRACT_VERSION} from "./portal-connector-platform.mjs";

const commonReadCapabilities=Object.freeze([
  "DISCOVER","LOGIN","MFA","NAVIGATE","EXPAND_DOCUMENT_TREE","FOLLOW_PARTNER_SYSTEM",
  "DOWNLOAD","CLASSIFY","EXTRACT","RETRY"
]);

const definition=(adapterId,displayName,variants=[])=>Object.freeze({
  adapterId,displayName,contractVersion:PORTAL_ADAPTER_CONTRACT_VERSION,
  lifecycle:[...commonReadCapabilities],variants,
  bindingOperations:Object.freeze({participation:false,submission:false,communication:false,withdrawal:false,revocation:false}),
  submissionArchitecture:Object.freeze({internalBuild:true,internalValidation:true,internalMapping:true,externalStaging:false,bindingTransfer:false,httpStatus:423}),
  monitoring:Object.freeze({modelSupported:true,portalPollerStatus:"EVIDENCE_REQUIRED",externalWrite:false}),
  validationStatus:"LIVE_VALIDATION_REQUIRED",
  participationStatus:"BOARD_APPROVAL_AND_LIVE_VALIDATION_REQUIRED"
});

export const PORTAL_ADAPTER_CATALOG=Object.freeze([
  definition("deutsche-evergabe","Deutsche eVergabe"),
  definition("evergabe-bayern","eVergabe Bayern"),
  definition("dtvp","DTVP"),
  definition("rib-meinauftrag","RIB / Meinauftrag",["RIB"]),
  definition("vergabe24","Vergabe24"),
  definition("ted","TED"),
  definition("datenservice-oeffentlicher-einkauf","Datenservice Öffentlicher Einkauf"),
  definition("ai-vergabe-manager","AI Vergabemanager"),
  definition("cosinex","Cosinex",["Vergabemarktplatz","VMS" ]),
  definition("vms","VMS"),
  definition("subreport","subreport"),
  definition("bi-medien","bi-medien"),
  definition("aumass","AUMASS eVergabe"),
  definition("evergabe-de","evergabe.de"),
  definition("eu-funding-tenders","EU Funding & Tenders / eSubmission"),
  definition("etenders-ireland","eTenders Ireland"),
  definition("kommunalportal","Kommunale Portale"),
  definition("bundeslandportal","Bundesländerportale"),
  definition("generic-public-procurement","Sonstige öffentliche Vergabeplattformen")
]);

export function catalogAdapter(adapterId){return PORTAL_ADAPTER_CATALOG.find(item=>item.adapterId===adapterId)||null}
export function adapterCoverageMatrix(liveEvidence=[]){
  const evidence=new Map(liveEvidence.map(item=>[item.adapterId,item]));
  return PORTAL_ADAPTER_CATALOG.map(adapter=>{
    const current=evidence.get(adapter.adapterId);
    return {...adapter,validationStatus:current?.validationStatus||adapter.validationStatus,lastLiveTestAt:current?.lastLiveTestAt||null,evidenceId:current?.evidenceId||null};
  });
}
