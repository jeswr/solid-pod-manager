import { describe, it, expect } from "vitest";
import { parseRdf } from "@jeswr/fetch-rdf";
import { localName, readResourceProperties } from "./resource-view.js";

describe("localName", () => {
  it("uses the fragment, then the last path segment", () => {
    expect(localName("http://xmlns.com/foaf/0.1/name")).toBe("name");
    expect(localName("https://schema.org/Event")).toBe("Event");
    expect(localName("https://a.example/doc")).toBe("doc");
  });
});

describe("readResourceProperties", () => {
  const URL = "https://alice.example/profile/card";

  it("groups by subject, primary subject first, predicates sorted", async () => {
    const ds = await parseRdf(
      `
      @prefix foaf: <http://xmlns.com/foaf/0.1/>.
      <${URL}> a foaf:PersonalProfileDocument ; foaf:maker <${URL}#me> .
      <${URL}#me> a foaf:Person ; foaf:name "Alice" ; foaf:age "30" .
    `,
      "text/turtle",
      { baseIRI: URL },
    );
    const groups = readResourceProperties(URL, ds);

    // The doc and #me are both primary candidates; both come before others.
    const primary = groups.filter((g) => g.primary).map((g) => g.subject);
    expect(primary).toContain(`${URL}#me`);

    const me = groups.find((g) => g.subject === `${URL}#me`);
    expect(me?.properties.map((p) => p.label)).toEqual(["age", "name", "type"]); // sorted
    const name = me?.properties.find((p) => p.label === "name");
    expect(name?.values[0]).toEqual({ value: "Alice", kind: "literal" });
  });

  it("distinguishes named-node values from literals", async () => {
    const ds = await parseRdf(
      `@prefix foaf: <http://xmlns.com/foaf/0.1/>.
       <${URL}#me> foaf:knows <https://bob.example/card#me> ; foaf:name "Alice" .`,
      "text/turtle",
      { baseIRI: URL },
    );
    const groups = readResourceProperties(URL, ds);
    const me = groups.find((g) => g.subject === `${URL}#me`);
    const knows = me?.properties.find((p) => p.label === "knows");
    expect(knows?.values[0].kind).toBe("named");
    expect(knows?.values[0].value).toBe("https://bob.example/card#me");
  });

  it("collects multiple values for one predicate", async () => {
    const ds = await parseRdf(
      `@prefix foaf: <http://xmlns.com/foaf/0.1/>.
       <${URL}#me> foaf:nick "ally", "al" .`,
      "text/turtle",
      { baseIRI: URL },
    );
    const me = readResourceProperties(URL, ds).find((g) => g.subject === `${URL}#me`);
    const nick = me?.properties.find((p) => p.label === "nick");
    expect(nick?.values.map((v) => v.value).sort()).toEqual(["al", "ally"]);
  });
});
