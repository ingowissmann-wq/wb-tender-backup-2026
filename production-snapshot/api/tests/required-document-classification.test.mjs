import test from "node:test";
import assert from "node:assert/strict";
import {
  REQUIREMENT_CLASSIFIER_VERSION,
  classifyRequirementEvidence,
  discoverSourceRequirements,
} from "../platform/generic-final-preflight.mjs";

const sourceDocumentId="11111111-1111-4111-8111-111111111111";
const discover=(text,page=1)=>discoverSourceRequirements({pages:[{page,text}],sourceDocumentId,sourceReference:"synthetic.pdf",lotKey:"LOT-0001",deadline:"2026-09-01"});

test("post-award insurance proof is excluded from bid-time requirements with deterministic reason",()=>{
  const text="DIENSTLEISTUNGSVERTRAG Die Betriebshaftpflichtversicherung ist aufrechtzuerhalten. Der Nachweis hierüber ist nach Zuschlagserteilung dem Auftraggeber vorzulegen.";
  const classification=classifyRequirementEvidence(text);
  assert.equal(classification.classification,"POST_AWARD_EVIDENCE");
  assert.equal(classification.rule,"POST_AWARD_EXPLICIT");
  assert.equal(classification.eligible,false);
  assert.deepEqual(discover(text,52),[]);
});

test("contract-performance evidence due before personnel deployment is excluded",()=>{
  const text="Leistungsbeschreibung. Die Nachweise für Erst-Hilfe-Lehrgang und gesundheitliche Eignung sind vom AN für jede Person spätestens 10 Tage vor dem geplanten Einsatz dem AG vorzulegen.";
  const classification=classifyRequirementEvidence(text);
  assert.equal(classification.classification,"CONTRACT_PERFORMANCE_CLAUSE");
  assert.equal(classification.rule,"PERFORMANCE_TIME_EXPLICIT");
  assert.equal(classification.eligible,false);
  assert.deepEqual(discover(text,68),[]);
});

test("page-69 personnel certificates due before deployment are contract-performance evidence",()=>{
  const result=classifyRequirementEvidence("Dieses Führungszeugnis ist dem Auftraggeber mindestens sechs Wochen vor dem Einsatz im Original zu übermitteln. Führungszeugnisse sind jährlich vom Auftragnehmer vorzulegen; Personal ohne Nachweis darf er nicht einsetzen.");
  assert.equal(result.classification,"CONTRACT_PERFORMANCE_CLAUSE");assert.equal(result.eligible,false);assert.equal(result.rule,"PERFORMANCE_TIME_EXPLICIT");
});

test("explicit bid-time evidence remains an upload-only required document",()=>{
  const text="Der Versicherungsnachweis ist mit dem Angebot einzureichen.";
  const [item]=discover(text,7);
  assert.ok(item);
  assert.equal(item.requirementClassification,"BID_TIME_UPLOAD_EVIDENCE");
  assert.equal(item.classificationProvenance.classifierVersion,REQUIREMENT_CLASSIFIER_VERSION);
  assert.equal(item.classificationProvenance.rule,"BID_TIME_UPLOAD_EXPLICIT");
  assert.equal(item.classificationProvenance.deterministic,true);
  assert.equal(item.sourcePage,7);
  assert.equal(item.mandatory,true);
  assert.equal(item.submissionRelevant,true);
});

test("explicit bidder fields are classified as a fillable form",()=>{
  const text="Angaben zur Bietereignung [Mussangabe] Können Sie dies zusichern? [ ] Keine Angabe [ ] Ja [ ] Nein Nur eine Antwort wählbar.";
  const classification=classifyRequirementEvidence(text);
  assert.equal(classification.classification,"FILLABLE_BIDDER_FORM");
  assert.equal(classification.actionType,"PDF_EDITOR");
});

test("informational insurance text is not promoted to a bid-time blocker",()=>{
  const text="Information: Die Betriebshaftpflichtversicherung wird im Dienstleistungsvertrag beschrieben.";
  assert.equal(classifyRequirementEvidence(text).classification,"INFORMATIONAL_TEXT");
  assert.deepEqual(discover(text,48),[]);
});
