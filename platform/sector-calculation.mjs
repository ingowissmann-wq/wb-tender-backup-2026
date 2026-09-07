import {snapshotHash} from "./canonical-truth.mjs";
import {normalizeUnit, normalizeDecimal} from "./unit-catalog.mjs";

export const CALCULATION_FORMULA_VERSION="WB_COST_CATALOG_V4";
const money=value=>Math.round((value+Number.EPSILON)*100)/100;

// Every cost uses its catalog unit. A missing value is never a zero cost.
export function calculateSectorTender({serviceArea,parameters={},facts={},provenance={},effectiveAt}={}) {
 const missing=[], values={}, units={};
 const need=(name,value,{positive=false}={})=>{const n=normalizeDecimal(value);if(n===null||n<0||(positive&&n===0)){missing.push(name);return null;}return n;};
 if(!["cleaning","security","facility_management","facility-management"].includes(serviceArea))missing.push("Leistungsart");
 const point=Date.parse(effectiveAt);
 if(!Number.isFinite(point))missing.push("Gültigkeitsdatum");
 const keys=Array.from({length:21},(_,i)=>`C${String(i+1).padStart(2,"0")}`);
 if(serviceArea==='security')keys.push('S01','S02','S03','S04');
 for(const key of keys){
  const item=parameters[key];
  if(!item||typeof item!=="object"||!item.sourceVersionId||!item.parameterId||!item.validFrom){missing.push(`${key} freigegebene Quelle`);continue;}
  if(!Number.isFinite(Date.parse(item.validFrom))||Date.parse(item.validFrom)>point||(item.validUntil&&(!Number.isFinite(Date.parse(item.validUntil))||Date.parse(item.validUntil)<point))){missing.push(`${key} Gültigkeit`);continue;}
  const unit=normalizeUnit(key,item.unit);if(!unit){missing.push(`${key} Einheit`);continue;}units[key]=unit.id;
  if(key==='C02'){if(!item.value||!String(typeof item.value==='object'?JSON.stringify(item.value):item.value).trim())missing.push('C02 Tarifgrundlage');values[key]=item.value;}
  else if(key==='C03')values[key]=item.value;
  else values[key]=need(key,item.value,{positive:key==='C01'});
 }
 const hours=need('Produktivstunden',facts.productiveHours??facts.requiredHours??facts.hours,{positive:true});
 const months=need('Vertragslaufzeit in Monaten',facts.duration,{positive:true});
 if(!provenance.productiveHours?.source)missing.push('Produktivstunden Quelle');
 if(!provenance.contractDuration?.source)missing.push('Vertragslaufzeit Quelle');
 for(const cell of facts.requiredCells||[]){
  if(!cell?.address||!cell.source||normalizeDecimal(cell.value)===null||normalizeDecimal(cell.value)<=0)missing.push(`Pflichtfeld ${cell?.address||'unbekannt'}`);
 }
 const blocked=()=>({schemaVersion:4,formulaVersion:CALCULATION_FORMULA_VERSION,status:'CALCULATION_BLOCKED_MISSING_INPUT',missing:[...new Set(missing)],provenance,externalTransmission:false});
 if(missing.length)return blocked();
 const directWages=money(hours*values.C01);
 let supplements=0;
 // Percent-by-type requires matching actual hours, including explicit zeros.
 const supplementRates=values.C03;
 if(!supplementRates||typeof supplementRates!=='object'||Array.isArray(supplementRates)||Object.keys(supplementRates).length===0){missing.push('C03 Zuschläge je Art');}
 else for(const [kind,rate] of Object.entries(supplementRates)){
  const pct=need(`C03 ${kind}`,rate);if(pct===0)continue;
  const quantity=need(`${kind} Zuschlagsstunden`,facts.supplementHours?.[kind]);
  if(pct!==null&&quantity!==null){if(quantity>hours)missing.push(`${kind} Zuschlagsstunden überschreiten Gesamtstunden`);else supplements+=money(quantity*values.C01*pct/100);}
 }
 const percent=(base,key)=>money(base*values[key]/100);
 const employerOnCosts=percent(directWages+supplements,'C04');
 const holidayReserve=percent(directWages,'C05'),sicknessReserve=percent(directWages,'C06'),otherAbsenceReserve=percent(directWages,'C07');
 const personnel=directWages+supplements+employerOnCosts+holidayReserve+sicknessReserve+otherAbsenceReserve;
 const cost=(key,base)=>{
  const rate=values[key];if(rate===0)return 0;
  const unit=units[key];if(unit==='PERCENT')return money(base*rate/100);
  if(unit==='EUR')return rate;
  if(unit==='EUR_PER_HOUR')return money(rate*hours);
  if(unit==='EUR_PER_MONTH')return money(rate*months);
  if(unit==='EUR_PER_YEAR')return money(rate*months/12);
  const quantity=need(`${key} Menge (${unit})`,facts.quantities?.[key]);
  if(!provenance.quantities?.[key]?.source)missing.push(`${key} Mengenquelle`);
  return quantity===null?0:money(rate*quantity);
 };
 const material=cost('C11',personnel),equipment=cost('C12',personnel),vehicles=cost('C13',personnel),travel=cost('C14',personnel),subcontractors=cost('C16',personnel);
 const securityNonPersonnelCosts=serviceArea==='security'?['S01','S02','S03','S04'].reduce((sum,key)=>sum+cost(key,personnel),0):0;
 const directCosts=money(personnel+material+equipment+vehicles+travel+subcontractors+securityNonPersonnelCosts);
 const siteManagement=cost('C09',personnel),operationsManagement=cost('C10',personnel),recruiting=cost('C15',personnel),insurance=cost('C17',directCosts);
 const attributableCosts=money(directCosts+siteManagement+operationsManagement+recruiting+insurance);
 const overhead=cost('C08',attributableCosts),risk=percent(attributableCosts+overhead,'C18');
 const totalCosts=money(attributableCosts+overhead+risk);
 // Honor all three approved contribution targets; never silently clamp them.
 const target=(base,key)=>{if(units[key]==='EUR')return base+values[key];if(values[key]>=100){missing.push(`${key} muss kleiner als 100 Prozent sein`);return 0;}return base/(1-values[key]/100);};
 const targetPrice=Math.ceil((Math.max(target(directCosts,'C19'),target(attributableCosts,'C20'),target(totalCosts,'C21'))-Number.EPSILON)*100)/100;
 if(![directCosts,attributableCosts,totalCosts,targetPrice].every(Number.isFinite))missing.push("Kostenwerte außerhalb des berechenbaren Bereichs");
 if(missing.length)return blocked();
 const result={schemaVersion:4,formulaVersion:CALCULATION_FORMULA_VERSION,status:'CALCULATED',serviceArea,effectiveAt:new Date(point).toISOString(),productiveHours:money(hours),hoursPerMonth:money(hours/months),hoursPerYear:money(hours/months*12),
 directWages,supplements:money(supplements),employerOnCosts,holidayReserve,sicknessReserve,otherAbsenceReserve,material,equipment,vehicles,travel,subcontractors,securityNonPersonnelCosts,siteManagement,operationsManagement,recruiting,insurance,overhead,risk,directCosts,attributableCosts,totalCosts,
 db1:money(targetPrice-directCosts),db2:money(targetPrice-attributableCosts),db3:money(targetPrice-totalCosts),profit:money(targetPrice-totalCosts),hourlyRate:money(targetPrice/hours),monthlyPrice:money(targetPrice/months),annualPrice:money(targetPrice/months*12),totalPrice:targetPrice,
 inputVersion:snapshotHash({serviceArea,parameters,facts,provenance,effectiveAt}),provenance,externalTransmission:false};
 return {...result,calculationHash:snapshotHash(result)};
}

export function buildManagementOutput({tender,lotKey,company,profileSnapshot,documentRevision,calculation,missing=[],jobId,correlationId,now=new Date().toISOString()}={}) {
  const calculated=["CALCULATED","CALCULATED_REAL","CALCULATION_PARTIAL"].includes(calculation?.status),partial=calculation?.status==="CALCULATION_PARTIAL",missingFacilityProfile=calculation?.status==="CALCULATION_BLOCKED_MISSING_FACILITY_PROFILE";
  const output={schemaVersion:3,status:calculated?"MANAGEMENT_OUTPUT_GENERATED":missingFacilityProfile?"CALCULATION_BLOCKED_MISSING_FACILITY_PROFILE":"NICHT_KALKULIERBAR_FEHLENDE_TENDERUNTERLAGEN",executiveSummary:{buyer:tender?.buyer||null,tender:tender?.title||null,lot:lotKey||null,serviceArea:company?.sector_slug||null,deadline:tender?.offer_deadline||null},recommendation:{decision:partial?"MANAGEMENT_REVIEW_REQUIRED_PARTIAL":calculated?"CONDITIONAL_GO":"NICHT_ANGEBOTSFÄHIG",reason:partial?"Belastbare Teilkalkulation liegt vor; ausgewiesene Einzelpositionen benötigen noch einen quellengebundenen Kostenansatz.":calculated?"Kalkulation liegt vollständig und quellengebunden zur fachlichen Entscheidung vor.":missingFacilityProfile?"Für company_id und Facility-Service-Line existiert kein aktives, freigegebenes Kalkulationsprofil; eine fachfremde Fallback-Auflösung ist gesperrt.":"Tenderbezogene Pflichtangaben fehlen.",requiredActions:missing.map(item=>item.field||item)},calculation:calculated?calculation:null,personnel:calculated?{productiveHours:calculation.productiveHours,fte:calculation.fte}:null,risks:{classification:calculated?"FACHLICHE_PRÜFUNG_ERFORDERLICH":missingFacilityProfile?"FACILITY_PROFILE_MISSING":"DOKUMENTENRISIKO",items:[]},capacity:{status:calculated?"AUS_EFFECTIVE_PROFILE_GEBUNDEN":missingFacilityProfile?"FACILITY_PROFILE_REQUIRED":"NACH_DOKUMENTEINGANG_NEU_BEWERTEN"},awardChance:{value:null,confidence:"NOT_ENOUGH_AUTHORITATIVE_DATA",invented:false},evidence:{missing,profileComplete:!missingFacilityProfile},nextSteps:calculated?[{action:"BOARD_REVIEW",priority:"HIGH"}]:missingFacilityProfile?[{action:"APPROVE_FACILITY_CALCULATION_PROFILE",priority:"HIGH"}]:[{action:"AUTOMATIC_DOCUMENT_REFETCH",priority:"HIGH"}],provenance:{profileSnapshotId:profileSnapshot?.id||null,profileRevision:profileSnapshot?.revision||null,documentRevision,calculationVersion:calculation?.schemaVersion||null,managementOutputVersion:3,jobId,correlationId,generatedAt:now},externalTransmission:false};
  return {...output,outputHash:snapshotHash(output)};
}
