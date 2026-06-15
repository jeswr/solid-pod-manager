// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect } from "vitest";
import { RdfValidateShaclValidator, getDefaultValidator } from "./validator.js";
import issueShapes from "./shapes/issue.ttl";

const WF = "http://www.w3.org/2005/01/wf/flow#";
const DCT = "http://purl.org/dc/terms/";

// A conforming wf:Task (open issue with a title) — Turtle the PM's buildIssue
// would emit. The validator is the swap-point seam (ADR-0014 / sparq #162).
const CONFORMING_ISSUE = `
@prefix wf: <${WF}> .
@prefix dct: <${DCT}> .
<http://x/u.ttl#it> a wf:Task, wf:Open ;
  dct:title "Login button overflows on mobile" .
`;

const NO_TITLE_ISSUE = `
@prefix wf: <${WF}> .
<http://x/u.ttl#it> a wf:Task, wf:Open .
`;

const NON_WEB_ASSIGNEE = `
@prefix wf: <${WF}> .
@prefix dct: <${DCT}> .
<http://x/u.ttl#it> a wf:Task, wf:Open ;
  dct:title "Has a non-web assignee" ;
  wf:assignee <urn:agent:bob> .
`;

const STATELESS_TASK = `
@prefix wf: <${WF}> .
@prefix dct: <${DCT}> .
<http://x/u.ttl#it> a wf:Task ;
  dct:title "Stateless task" .
`;

describe("RdfValidateShaclValidator (ADR-0014 seam)", () => {
  const validator = new RdfValidateShaclValidator();

  it("a conforming issue reports conforms:true with no results", async () => {
    const report = await validator.validate(CONFORMING_ISSUE, issueShapes);
    expect(report.conforms).toBe(true);
    expect(report.results).toEqual([]);
  });

  it("a missing-title issue reports conforms:false flagging dct:title", async () => {
    const report = await validator.validate(NO_TITLE_ISSUE, issueShapes);
    expect(report.conforms).toBe(false);
    expect(report.results.some((r) => r.path === `${DCT}title`)).toBe(true);
  });

  it("a non-http(s) assignee IRI is flagged on wf:assignee", async () => {
    const report = await validator.validate(NON_WEB_ASSIGNEE, issueShapes);
    expect(report.conforms).toBe(false);
    expect(report.results.some((r) => r.path === `${WF}assignee`)).toBe(true);
  });

  it("a wf:Task with no state class is flagged at Warning severity (advisory)", async () => {
    const report = await validator.validate(STATELESS_TASK, issueShapes);
    expect(report.conforms).toBe(false);
    const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
    const stateResult = report.results.find((r) => r.path === RDF_TYPE);
    expect(stateResult).toBeDefined();
    expect(stateResult?.severity).toBe("http://www.w3.org/ns/shacl#Warning");
  });

  it("getDefaultValidator() returns a working ShaclValidator (the swap point)", async () => {
    const report = await getDefaultValidator().validate(CONFORMING_ISSUE, issueShapes);
    expect(report.conforms).toBe(true);
  });

  it("an unparseable data graph never crashes the caller via the seam", async () => {
    // The interface contract: validate() may reject only on genuinely
    // unparseable input. The advisory wrapper (advisory.test.ts) swallows that;
    // here we just assert the seam surfaces it as a rejected promise, not a hang.
    await expect(validator.validate("@@ not turtle @@", issueShapes)).rejects.toBeDefined();
  });
});
