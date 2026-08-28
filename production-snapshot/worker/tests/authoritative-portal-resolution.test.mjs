import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyAuthoritativePortalLink,
  resolveAuthoritativePortalEvidence,
} from "../platform/authoritative-portal-resolution.mjs";
import { extractNoticePortalLinkEvidence } from "../platform/enrichment-core.mjs";

const portals = [
  {
    id: "ted",
    canonical_domain: "ted.europa.eu",
    allowed_subdomains: [],
    authentication_domains: [],
    download_domains: [],
  },
  {
    id: "external",
    canonical_domain: "vergabe.example.de",
    allowed_subdomains: ["docs.vergabe.example.de"],
    authentication_domains: ["login.vergabe.example.de"],
    download_domains: ["docs.vergabe.example.de"],
  },
];

test("TED remains notice source while an external submission portal resolves independently", () => {
  const result = resolveAuthoritativePortalEvidence([
    { url: "https://ted.europa.eu/en/notice/1", role: "NOTICE" },
    { url: "https://vergabe.example.de/submission/1", role: "SUBMISSION" },
  ], portals);
  const notice = result.resolutions.find((row) => row.role === "NOTICE");
  const submission = result.resolutions.find((row) => row.role === "SUBMISSION");
  assert.equal(notice.portalId, "ted");
  assert.equal(submission.portalId, "external");
  assert.notEqual(notice.portalId, submission.portalId);
});

test("unknown and ambiguous action hosts fail closed", () => {
  const unknown = resolveAuthoritativePortalEvidence([
    { url: "https://unknown.example.org/files/1", role: "PROCUREMENT_DOCUMENT" },
  ], portals).resolutions.find((row) => row.role === "PROCUREMENT_DOCUMENT");
  assert.equal(unknown.status, "NOT_FOUND");
  assert.equal(unknown.portalId, null);

  const ambiguous = resolveAuthoritativePortalEvidence([
    { url: "https://shared.example.org/submission/1", role: "SUBMISSION" },
  ], [
    { ...portals[1], id: "one", allowed_subdomains: ["shared.example.org"] },
    { ...portals[1], id: "two", allowed_subdomains: ["shared.example.org"] },
  ]).resolutions.find((row) => row.role === "SUBMISSION");
  assert.equal(ambiguous.status, "REVIEW_REQUIRED");
  assert.equal(ambiguous.portalId, null);
});

test("eForms URI paths classify action roles without promoting unrelated URIs", () => {
  assert.equal(classifyAuthoritativePortalLink({
    url: "https://vergabe.example.de/submit",
    path: "$.TenderSubmission.URI",
  }).role, "SUBMISSION");
  assert.equal(classifyAuthoritativePortalLink({
    url: "https://buyer.example.org/profile",
    path: "$.BuyerProfile.URI",
  }), null);
});

test("DOE technical URI is notice evidence and only tender documents become download evidence", () => {
  const raw = {
    uri: "https://oeffentlichevergabe.de/api/notices/1?format=ocds",
    tender: {
      documents: [{ url: "https://docs.vergabe.example.de/file.pdf" }],
      submission_url: "https://vergabe.example.de/submission/1",
    },
  };
  const evidence = extractNoticePortalLinkEvidence(Buffer.from(JSON.stringify(raw)), {
    source: "DOE",
    url: raw.uri,
    contentType: "application/json",
  });
  assert.deepEqual(new Set(evidence.map((row) => row.role)), new Set([
    "NOTICE",
    "PROCUREMENT_DOCUMENT",
    "SUBMISSION",
  ]));
});
