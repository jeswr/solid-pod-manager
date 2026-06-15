// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect } from "vitest";
import { parseRdf } from "@jeswr/fetch-rdf";
import type { DatasetCore } from "@rdfjs/types";
import { parseUiForm, labelFromPredicate, findFormSubject } from "./ui-form.js";

const BASE = "https://alice.example/forms/contact.ttl";

async function ds(turtle: string): Promise<DatasetCore> {
  return parseRdf(turtle, "text/turtle", { baseIRI: BASE });
}

const PREFIX = `
  @prefix ui: <http://www.w3.org/ns/ui#>.
  @prefix vcard: <http://www.w3.org/2006/vcard/ns#>.
  @prefix : <${BASE}#>.
`;

describe("parseUiForm — ui:Group with ui:parts (RDF list)", () => {
  it("flattens an ordered parts list into typed fields bound to predicates", async () => {
    const d = await ds(`${PREFIX}
      :form a ui:Form ; ui:parts ( :nameField :emailField :bioField ) .
      :nameField a ui:SingleLineTextField ; ui:property vcard:fn ; ui:label "Full name" ; ui:required true .
      :emailField a ui:EmailField ; ui:property vcard:hasEmail ; ui:label "Email" .
      :bioField a ui:MultiLineTextField ; ui:property vcard:note ; ui:label "About" .`);

    const fields = parseUiForm(d);
    expect(fields.map((f) => f.label)).toEqual(["Full name", "Email", "About"]);
    expect(fields.map((f) => f.kind)).toEqual(["text", "email", "textarea"]);
    expect(fields.map((f) => f.mode)).toEqual(["literal", "mailto", "literal"]);
    expect(fields[0].predicate).toBe("http://www.w3.org/2006/vcard/ns#fn");
    expect(fields[0].required).toBe(true);
    expect(fields[1].required).toBe(false);
  });
});

describe("parseUiForm — widget kinds", () => {
  it("maps the common ui: field classes to kinds + modes", async () => {
    const d = await ds(`${PREFIX}
      :form a ui:Form ; ui:parts ( :a :b :c :d :e :f ) .
      :a a ui:BooleanField ; ui:property :flag .
      :b a ui:DateField ; ui:property :on .
      :c a ui:DateTimeField ; ui:property :at .
      :d a ui:IntegerField ; ui:property :count .
      :e a ui:DecimalField ; ui:property :amount .
      :f a ui:NamedNodeURIField ; ui:property :link .`);

    const fields = parseUiForm(d);
    const byPred = Object.fromEntries(fields.map((f) => [f.predicate.split("#").pop(), f]));
    expect(byPred.flag.kind).toBe("boolean");
    expect(byPred.on.kind).toBe("date");
    expect(byPred.at.kind).toBe("datetime");
    expect(byPred.count.kind).toBe("number");
    expect(byPred.amount.kind).toBe("decimal");
    expect(byPred.link.kind).toBe("url");
    expect(byPred.link.mode).toBe("iri");
  });
});

describe("parseUiForm — nested groups + ui:part fallback", () => {
  it("flattens nested ui:Group children via ui:part (no list)", async () => {
    const d = await ds(`${PREFIX}
      :form a ui:Form ; ui:part :grp .
      :grp a ui:Group ; ui:part :name, :phone .
      :name a ui:SingleLineTextField ; ui:property vcard:fn .
      :phone a ui:PhoneField ; ui:property vcard:hasTelephone .`);
    const fields = parseUiForm(d);
    expect(fields).toHaveLength(2);
    expect(fields.map((f) => f.kind).sort()).toEqual(["tel", "text"]);
  });

  it("derives a label from the predicate when ui:label is absent", async () => {
    const d = await ds(`${PREFIX}
      :form a ui:Form ; ui:parts ( :f ) .
      :f a ui:SingleLineTextField ; ui:property <https://schema.org/birthDate> .`);
    const [field] = parseUiForm(d);
    expect(field.label).toBe("Birth Date");
  });
});

describe("parseUiForm — choice fields", () => {
  it("reads ui:Classifier options from a ui:values list with labels", async () => {
    const d = await ds(`${PREFIX}
      :form a ui:Form ; ui:parts ( :status ) .
      :status a ui:Classifier ; ui:property <https://schema.org/eventStatus> ;
        ui:label "Status" ; ui:values ( :scheduled :cancelled ) .
      :scheduled ui:label "Scheduled" .
      :cancelled ui:label "Cancelled" .`);
    const [field] = parseUiForm(d);
    expect(field.kind).toBe("choice");
    expect(field.options?.map((o) => o.label)).toEqual(["Scheduled", "Cancelled"]);
  });
});

describe("parseUiForm — robustness", () => {
  it("returns [] for a dataset with no form", async () => {
    const d = await ds(`<${BASE}#x> <https://schema.org/name> "not a form" .`);
    expect(parseUiForm(d)).toEqual([]);
    expect(findFormSubject(d)).toBeUndefined();
  });

  it("skips a field with no ui:property", async () => {
    const d = await ds(`${PREFIX}
      :form a ui:Form ; ui:parts ( :ghost :real ) .
      :ghost a ui:SingleLineTextField ; ui:label "No predicate" .
      :real a ui:SingleLineTextField ; ui:property vcard:fn .`);
    const fields = parseUiForm(d);
    expect(fields).toHaveLength(1);
    expect(fields[0].predicate).toBe("http://www.w3.org/2006/vcard/ns#fn");
  });
});

describe("labelFromPredicate", () => {
  it("title-cases the local name", () => {
    expect(labelFromPredicate("https://schema.org/startDate")).toBe("Start Date");
    expect(labelFromPredicate("http://www.w3.org/2006/vcard/ns#fn")).toBe("Fn");
  });
});
