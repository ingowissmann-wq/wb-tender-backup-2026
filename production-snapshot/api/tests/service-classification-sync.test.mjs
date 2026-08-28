import assert from "node:assert/strict";
import test from "node:test";
import { classifyTenderServices } from "../platform/service-relevance.mjs";

const companies = [
  ["cleaning", "WB Cleaning"],
  ["security", "WB Security"],
  ["facility-management", "WB Facility"],
  ["sicherheitstechnik", "WB Sicherheitstechnik"],
  ["emergency-services", "WB Emergency"],
].map(([sector_slug, legal_name], index) => ({ company: { company_id: `00000000-0000-4000-8000-00000000000${index}`, sector_slug, legal_name, technical_key: `company-${index}` }, parameters: [], profile: null }));

test("source CPV is preferred for an exact existing service-line assignment", () => {
  const result = classifyTenderServices({ tender: { id: "t1", title: "Dienstleistung", description: "Leistungsbeschreibung", cpv_codes: ["90911200"] }, companies });
  assert.equal(result.primary.serviceLine, "cleaning");
  assert.equal(result.primary.relevanceStatus, "RELEVANT");
  assert.match(result.primary.reason, /CPV/);
});

test("title and description rules classify without a CPV code", () => {
  const result = classifyTenderServices({ tender: { id: "t2", title: "Objektschutz und Pfortendienst", description: "Bewachung mehrerer Standorte", cpv_codes: [] }, companies });
  assert.equal(result.primary.serviceLine, "security");
});

test("unknown work is retained in the existing manual review group", () => {
  const result = classifyTenderServices({ tender: { id: "t3", title: "Unbekannte spezialisierte Leistung", description: "Keine eindeutigen vorhandenen Gewerkmerkmale", cpv_codes: ["99999999"] }, companies });
  assert.equal(result.primary, null);
  assert.equal(result.overallStatus, "MANUAL_CLASSIFICATION_REQUIRED");
  const review = result.evaluations.find((item) => item.relevanceStatus === "MANUAL_CLASSIFICATION_REQUIRED");
  assert.equal(review.serviceLine, "review");
  assert.match(review.reason, /Prüfgruppe/);
});

test("a canonical non-WB CPV division is classified as not relevant", () => {
  const result = classifyTenderServices({ tender: { id: "t4", title: "Ausführung einer Verkehrsanlage", description: "Technische Spezifikation", cpv_codes: ["45000000"] }, companies });
  assert.equal(result.decision.wbRelevanceStatus, "NOT_RELEVANT");
  assert.equal(result.decision.ruleId, "WB_CPV_DIVISION_OUTSIDE_SCOPE");
  assert.equal(result.primary, null);
});

test("a WB-adjacent CPV without positive evidence remains in review", () => {
  const result = classifyTenderServices({ tender: { id: "t5", title: "Spezialisierte Leistung", description: "Leistungsumfang noch zu prüfen", cpv_codes: ["79000000"] }, companies });
  assert.equal(result.decision.wbRelevanceStatus, "REVIEW_REQUIRED");
  assert.equal(result.decision.ruleId, "WB_ADJACENT_CPV_REVIEW");
});

test("IT security wording is excluded from physical security", () => {
  const result = classifyTenderServices({ tender: { id: "t6", title: "IT Security Services", description: "Cyber security und Informationssicherheit", cpv_codes: ["72000000"] }, companies });
  assert.equal(result.primary, null);
  assert.equal(result.decision.wbRelevanceStatus, "NOT_RELEVANT");
});

test("a Rettungsdienst equipment purchase is not classified as emergency service", () => {
  const result = classifyTenderServices({ tender: { id: "t7", title: "Lieferung von Geräten für den Rettungsdienst", description: "Beschaffung mobiler Datenerfassungsgeräte", cpv_codes: ["30200000"] }, companies });
  assert.equal(result.primary, null);
  assert.equal(result.decision.wbRelevanceStatus, "NOT_RELEVANT");
});

test("winter-service equipment is not classified as facility service", () => {
  const result = classifyTenderServices({ tender: { id: "t8", title: "Beschaffung von Winterdienstanbaugeräten", description: "Lieferung kommunaler Anbaustreuer", cpv_codes: ["34144420"] }, companies });
  assert.equal(result.primary, null);
  assert.equal(result.decision.wbRelevanceStatus, "NOT_RELEVANT");
});

test("one incidental description hit cannot override a non-WB title", () => {
  const result = classifyTenderServices({ tender: { id: "t9", title: "Kampfmittelberäumung", description: "Eine vorhandene Gefahrenmeldeanlage ist während der Arbeiten zu schützen", cpv_codes: ["45000000"] }, companies });
  assert.equal(result.primary, null);
  assert.equal(result.decision.wbRelevanceStatus, "NOT_RELEVANT");
});

test("emergency-service vehicle, equipment, clothing and software procurement stays excluded", () => {
  for (const [title, cpv] of [
    ["Beschaffung von Krankentransportwagen Typ B", "34114121"],
    ["Rettungsdienstbekleidung", "35113400"],
    ["Beschaffung von EKG-Geräten für den Rettungsdienst", "33123000"],
    ["Informationssystem und Einsatzabrechnung im Rettungsdienst", "48814000"],
  ]) {
    const result = classifyTenderServices({ tender: { id: title, title, description: "Rettungsdienst", cpv_codes: [cpv] }, companies });
    assert.equal(result.decision.wbRelevanceStatus, "NOT_RELEVANT");
  }
});

test("railway Sicherungsleistungen are not security guard services", () => {
  const result = classifyTenderServices({ tender: { id: "t10", title: "Generalsanierung Strecke - Sicherungsleistungen Bahn", description: "Bahnarbeiten", cpv_codes: ["79710000"] }, companies });
  assert.equal(result.decision.wbRelevanceStatus, "NOT_RELEVANT");
});

test("cleaning consultancy is not operational cleaning", () => {
  const result = classifyTenderServices({ tender: { id: "t11", title: "Rahmenvereinbarung Gutachter Reinigungsdienstleistungen", description: "Beratungsauftrag", cpv_codes: [] }, companies });
  assert.equal(result.decision.wbRelevanceStatus, "NOT_RELEVANT");
});

test("mobile bodycam SaaS is not fixed security technology", () => {
  const result = classifyTenderServices({ tender: { id: "t12", title: "Rahmenvereinbarung Bodycams inkl. Software-as-a-Service", description: "Mobile Geräte", cpv_codes: ["35125300"] }, companies });
  assert.equal(result.decision.wbRelevanceStatus, "NOT_RELEVANT");
});

test("emergency-service clothing and laundry remain outside the operational service scope", () => {
  for (const title of ["Rettungsdienststiefel", "Bereitstellung von Mietwäsche für den Rettungsdienst"]) {
    const result = classifyTenderServices({ tender: { id: title, title, description: "Rettungsdienst", cpv_codes: ["98310000"] }, companies });
    assert.equal(result.decision.wbRelevanceStatus, "NOT_RELEVANT");
  }
});

test("landscape construction is not promoted to operational facility management", () => {
  for (const title of ["Bauleistung", "Pflanzung K 1086", "Herstellung und Überarbeitung von Rasenflächen"]) {
    const result = classifyTenderServices({ tender: { id: title, title, description: "Außenanlage", cpv_codes: ["77310000"] }, companies });
    assert.equal(result.decision.wbRelevanceStatus, "NOT_RELEVANT");
  }
});

test("a broad security-system CPV without a service signal is not a confident assignment", () => {
  const result = classifyTenderServices({ tender: { id: "t13", title: "Zeus X", description: "Technische Leistung", cpv_codes: ["35123300", "35125200"] }, companies });
  assert.notEqual(result.decision.wbRelevanceStatus, "RELEVANT");
});

test("short but unambiguous non-WB CPV divisions are not left in manual review", () => {
  const result = classifyTenderServices({ tender: { id: "t14", title: "Technische Leistung", description: "Leistungsumfang", cpv_codes: ["43", "44", "45", "71"] }, companies });
  assert.equal(result.decision.wbRelevanceStatus, "NOT_RELEVANT");
  assert.equal(result.decision.ruleId, "WB_CPV_DIVISION_OUTSIDE_SCOPE");
});

test("specific waste, forestry, advertising, staffing and social-work CPVs are non-WB", () => {
  for (const cpv of ["90510000", "90430000", "77210000", "79340000", "79620000", "85312000"]) {
    const result = classifyTenderServices({ tender: { id: cpv, title: "Fachspezifische Leistung", description: "Leistungsumfang", cpv_codes: [cpv] }, companies });
    assert.equal(result.decision.wbRelevanceStatus, "NOT_RELEVANT");
  }
});

test("broad candidate CPV parents without evidence remain reviewable", () => {
  const result = classifyTenderServices({ tender: { id: "t15", title: "Spezialisierte Leistung", description: "Leistungsumfang", cpv_codes: ["79000000"] }, companies });
  assert.equal(result.decision.wbRelevanceStatus, "REVIEW_REQUIRED");
});

test("an erroneous alarm CPV cannot override an explicit recycling title", () => {
  const result = classifyTenderServices({ tender: { id: "t16", title: "Verwertung von Altpapier", description: "Recycling von Siedlungsabfällen", cpv_codes: ["90514000", "45312200"] }, companies });
  assert.equal(result.decision.wbRelevanceStatus, "NOT_RELEVANT");
});
