import {isExplicitlySupplied,snapshotHash} from "./canonical-truth.mjs";

const numeric=value=>{
  if(Array.isArray(value)){for(const item of value){const parsed=numeric(item);if(parsed!==null)return parsed}return null}
  const candidate=typeof value==="object"&&value!==null?(value.value??value.amount??value.percent??value.hours??value.rate):value;
  if(candidate===null||candidate===undefined||String(candidate).trim()==="")return null;
  const match=String(candidate).replace(/\s/g,"").replace(",",".").match(/-?\d+(?:\.\d+)?/),parsed=match?Number(match[0]):NaN;
  return Number.isFinite(parsed)?parsed:null;
};
const rate=(parameters,key,fallback=0)=>numeric(parameters[key])??fallback;
const money=value=>Math.round((value+Number.EPSILON)*100)/100;
const durationMonths=(value,fallback=12)=>{const values=Array.isArray(value)?value:[value];for(const item of values){const dates=[...String(item??"").matchAll(/(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})/g)].map(x=>new Date(Date.UTC(Number(x[3]),Number(x[2])-1,Number(x[1]))));if(dates.length>=2&&dates.at(-1)>=dates[0])return Math.max(1,(dates.at(-1).getUTCFullYear()-dates[0].getUTCFullYear())*12+dates.at(-1).getUTCMonth()-dates[0].getUTCMonth()+1)}const parsed=numeric(value);return parsed&&parsed>0?parsed:fallback};

export function calculateSectorTender({serviceArea,parameters={},facts={},provenance={},contractMonths=12}={}) {
  const productiveHours=numeric(facts.productiveHours??facts.requiredHours??facts.hours);
  const baseWage=rate(parameters,"C01",null);
  const missing=[];
  if(productiveHours===null||productiveHours<=0)missing.push("Produktivstunden");
  if(baseWage===null)missing.push("C01 Grundlohn");
  if((productiveHours===null||productiveHours<=0)&&!isExplicitlySupplied(facts.workdays))missing.push("Arbeitstage");
  if(!isExplicitlySupplied(facts.duration??contractMonths))missing.push("Vertragslaufzeit");
  if(missing.length)return {status:"CALCULATION_BLOCKED_MISSING_INPUT",missing,provenance,externalTransmission:false};
  const months=durationMonths(facts.duration,contractMonths);
  const fteDivisor=rate(parameters,"C05",173.33);
  const fte=productiveHours/(fteDivisor*Math.max(1,months));
  const directWages=productiveHours*baseWage;
  const supplements=directWages*rate(parameters,"C03")/100;
  const employerOnCosts=(directWages+supplements)*rate(parameters,"C04")/100;
  const holidayReserve=directWages*rate(parameters,"C06")/100;
  const sicknessReserve=directWages*rate(parameters,"C07")/100;
  const overhead=(directWages+supplements+employerOnCosts+holidayReserve+sicknessReserve)*rate(parameters,"C08")/100;
  const recruiting=fte*rate(parameters,"C09");
  const management=fte*rate(parameters,"C10");
  const material=rate(parameters,"C11");
  const equipment=rate(parameters,"C12");
  const clothing=rate(parameters,"C13");
  const vehicles=rate(parameters,"C14");
  const insurance=rate(parameters,"C15");
  const other=rate(parameters,"C16")+rate(parameters,"C17");
  const contractWeeks=Math.max(1,months)*52/12,securityVideo=serviceArea==="security"?rate(parameters,"S01"):0,securityFacilityWeeks=serviceArea==="security"?rate(parameters,"S02")*contractWeeks:0,securityEmergencyWeeks=serviceArea==="security"?rate(parameters,"S03")*contractWeeks:0,securitySiteEquipment=serviceArea==="security"?rate(parameters,"S04"):0,securityNonPersonnelCosts=securityVideo+securityFacilityWeeks+securityEmergencyWeeks+securitySiteEquipment;
  const costBase=directWages+supplements+employerOnCosts+holidayReserve+sicknessReserve+overhead+recruiting+management+material+equipment+clothing+vehicles+insurance+other+securityNonPersonnelCosts;
  const risk=costBase*rate(parameters,"C18")/100;
  const db1=rate(parameters,"C19"),db2=rate(parameters,"C20"),db3=rate(parameters,"C21");
  const total=costBase+risk;
  const targetPrice=total/(1-Math.min(95,db3||db2||db1||0)/100);
  const contribution1=targetPrice-directWages-supplements-employerOnCosts,contribution2=targetPrice-(directWages+supplements+employerOnCosts+holidayReserve+sicknessReserve+material+equipment+clothing+vehicles),contribution3=targetPrice-total,profit=targetPrice-total;
  const result={schemaVersion:3,status:"CALCULATED",serviceArea,productiveHours:money(productiveHours),hoursPerMonth:money(productiveHours/months),hoursPerYear:money(productiveHours/months*12),nightHours:money(numeric(facts.nightHours)||0),sundayHours:money(numeric(facts.sundayHours)||0),holidayHours:money(numeric(facts.holidayHours)||0),staffingStrength:numeric(facts.staffingStrength),fte:money(fte),directWages:money(directWages),supplements:money(supplements),employerOnCosts:money(employerOnCosts),holidayReserve:money(holidayReserve),sicknessReserve:money(sicknessReserve),otherAbsenceReserve:money(other),overhead:money(overhead),recruiting:money(recruiting),siteAndOperationsManagement:money(management),material:money(material),equipment:money(equipment),clothing:money(clothing),vehicles:money(vehicles),insurance:money(insurance),securityNonPersonnelCosts:money(securityNonPersonnelCosts),securityCostParameters:{S01:securityVideo,S02:rate(parameters,"S02"),S03:rate(parameters,"S03"),S04:securitySiteEquipment,contractWeeks:money(contractWeeks)},risk:money(risk),db1Percent:db1,db2Percent:db2,db3Percent:db3,db1:money(contribution1),db2:money(contribution2),db3:money(contribution3),profit:money(profit),hourlyRate:money(targetPrice/productiveHours),squareMeterPrice:serviceArea==="cleaning"&&numeric(facts.areas)?money(targetPrice/numeric(facts.areas)):null,monthlyPrice:money(targetPrice/months),annualPrice:money(targetPrice/months*12),totalPrice:money(targetPrice),pricePositions:facts.pricePositions||[],provenance,externalTransmission:false};
  return {...result,calculationHash:snapshotHash(result)};
}

export function buildManagementOutput({tender,lotKey,company,profileSnapshot,documentRevision,calculation,missing=[],jobId,correlationId,now=new Date().toISOString()}={}) {
  const calculated=["CALCULATED","CALCULATED_REAL","CALCULATION_PARTIAL"].includes(calculation?.status),partial=calculation?.status==="CALCULATION_PARTIAL",missingFacilityProfile=calculation?.status==="CALCULATION_BLOCKED_MISSING_FACILITY_PROFILE";
  const output={schemaVersion:3,status:calculated?"MANAGEMENT_OUTPUT_GENERATED":missingFacilityProfile?"CALCULATION_BLOCKED_MISSING_FACILITY_PROFILE":"NICHT_KALKULIERBAR_FEHLENDE_TENDERUNTERLAGEN",executiveSummary:{buyer:tender?.buyer||null,tender:tender?.title||null,lot:lotKey||null,serviceArea:company?.sector_slug||null,deadline:tender?.offer_deadline||null},recommendation:{decision:partial?"MANAGEMENT_REVIEW_REQUIRED_PARTIAL":calculated?"CONDITIONAL_GO":"NICHT_ANGEBOTSFÄHIG",reason:partial?"Belastbare Teilkalkulation liegt vor; ausgewiesene Einzelpositionen benötigen noch einen quellengebundenen Kostenansatz.":calculated?"Kalkulation liegt vollständig und quellengebunden zur fachlichen Entscheidung vor.":missingFacilityProfile?"Für company_id und Facility-Service-Line existiert kein aktives, freigegebenes Kalkulationsprofil; eine fachfremde Fallback-Auflösung ist gesperrt.":"Tenderbezogene Pflichtangaben fehlen.",requiredActions:missing.map(item=>item.field||item)},calculation:calculated?calculation:null,personnel:calculated?{productiveHours:calculation.productiveHours,fte:calculation.fte}:null,risks:{classification:calculated?"FACHLICHE_PRÜFUNG_ERFORDERLICH":missingFacilityProfile?"FACILITY_PROFILE_MISSING":"DOKUMENTENRISIKO",items:[]},capacity:{status:calculated?"AUS_EFFECTIVE_PROFILE_GEBUNDEN":missingFacilityProfile?"FACILITY_PROFILE_REQUIRED":"NACH_DOKUMENTEINGANG_NEU_BEWERTEN"},awardChance:{value:null,confidence:"NOT_ENOUGH_AUTHORITATIVE_DATA",invented:false},evidence:{missing,profileComplete:!missingFacilityProfile},nextSteps:calculated?[{action:"BOARD_REVIEW",priority:"HIGH"}]:missingFacilityProfile?[{action:"APPROVE_FACILITY_CALCULATION_PROFILE",priority:"HIGH"}]:[{action:"AUTOMATIC_DOCUMENT_REFETCH",priority:"HIGH"}],provenance:{profileSnapshotId:profileSnapshot?.id||null,profileRevision:profileSnapshot?.revision||null,documentRevision,calculationVersion:calculation?.schemaVersion||null,managementOutputVersion:3,jobId,correlationId,generatedAt:now},externalTransmission:false};
  return {...output,outputHash:snapshotHash(output)};
}
