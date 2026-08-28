import test from "node:test";
import assert from "node:assert/strict";
import {buildFullTenderReview} from "../platform/full-tender-review.mjs";
import {validateCalculationInputs} from "../platform/autopilot-pipeline-worker.mjs";

const companies={
  facility:{company_id:"facility-company",legal_name:"WB-Facilitys GmbH",technical_key:"wb-facilitys",sector_slug:"facility-management"},
  cleaning:{company_id:"cleaning-company",legal_name:"WB-Cleaning GmbH",technical_key:"wb-cleaning",sector_slug:"cleaning"},
  security:{company_id:"security-company",legal_name:"WB-Security GmbH",technical_key:"wb-security",sector_slug:"security"}
};
const tender=(id,title,description,cpv_codes)=>({id,title,description,cpv_codes,buyer:"Realer öffentlicher Auftraggeber",regions:["DE"],duration_months:24});
const review=(company,value,fields=[])=>buildFullTenderReview({tender:value,company,parameters:[],profile:{effective:{revision:"profile-v1",additional:{}}},enrichment:{version:1,structured_data:{title:value.title,description:value.description,duration:24}},enrichmentFields:fields.map(([field_key,v])=>({field_key,value:v,quality_status:"VORHANDEN",provenance:{source:"test"}})),enrichmentDocuments:[],region:{regional_decision:"INCLUDED",classification:"CORE_REGION"}});

const cases=[
  ["facility maintenance",companies.facility,tender("f1","Technisches Gebäudemanagement","Wartung von Heizungs- und Lüftungsanlagen mit Prüfzyklen und Reaktionszeiten",["50700000"]),["Technische Anlagen und Anlagenmengen","Wartungs- und Prüfzyklen","Reaktions- und Entstörzeiten"]],
  ["facility winter service",companies.facility,tender("f2","Hausmeister- und Winterdienst","Winterdienst und Grünpflege mit Bereitschaft und Einsatzzeiten",["90620000"]),["Rufbereitschaft und Bereitschaftszeiten","Facility-Einsatz- oder Leistungszeiten"]],
  ["cleaning one",companies.cleaning,tender("c1","Unterhaltsreinigung Schule","Flächen und Reinigungsintervalle",["90911200"]),["Reinigungsintervalle","Leistungsfrequenzen"]],
  ["cleaning two",companies.cleaning,tender("c2","Glasreinigung Verwaltung","Glasflächen und Reinigungsfrequenzen",["90911300"]),["Reinigungsintervalle","Leistungsfrequenzen"]],
  ["security one",companies.security,tender("s1","Objektschutz","Posten und Bewachungszeiten",["79713000"]),["Postenanzahl und Besetzung","Bewachungszeiten"]],
  ["security two",companies.security,tender("s2","Pforten- und Revierdienst","Schichten und Arbeitstage",["79710000"]),["Postenanzahl und Besetzung","Bewachungszeiten"]]
];

for(const [name,company,value,expected] of cases)test(name,()=>{
  const result=review(company,value),validation=validateCalculationInputs(result,[],null),labels=validation.checks.map(([label])=>label);
  for(const label of expected)assert.ok(labels.includes(label),`${label} missing`);
  if(company===companies.facility){
    assert.equal(result.calculation.status,"CALCULATION_BLOCKED_MISSING_FACILITY_PROFILE");
    assert.equal(labels.some(label=>/Reinigung|Flächen|Bewachung|Posten/.test(label)),false);
  }
  if(company===companies.cleaning)assert.equal(labels.some(label=>/Facility|Anlagen|Wartung|Rufbereitschaft/.test(label)),false);
  if(company===companies.security)assert.equal(labels.some(label=>/Facility|Reinigung|Wartung/.test(label)),false);
});

test("different facility tenders derive different requirements",()=>{
  const first=validateCalculationInputs(review(companies.facility,cases[0][2]),[],null).checks.map(([label])=>label);
  const second=validateCalculationInputs(review(companies.facility,cases[1][2]),[],null).checks.map(([label])=>label);
  assert.notDeepEqual(first,second);
});
