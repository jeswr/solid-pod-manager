import { describe, it, expect } from "vitest";
import { DataFactory } from "n3";
import { fileImport, memoryFile, TEST_POD_ROOT } from "../core/testing.js";
import { CLASSES, TextDocument } from "../core/vocab.js";
import { chatgptFileAdapter, parseChatgptExport } from "./file-adapter.js";

const DOC = `${TEST_POD_ROOT}integrations/chatgpt/documents/chatgpt-conversations.ttl`;

// Realistic conversations.json shape (array of {title, create_time, mapping}).
const SAMPLE = JSON.stringify([
  {
    id: "c1",
    title: "Solid pods explained",
    create_time: 1676368200, // 2023-02-14T09:50:00Z
    mapping: {
      n0: { message: null },
      n1: {
        message: {
          author: { role: "user" },
          create_time: 1676368201,
          content: { content_type: "text", parts: ["What is a Solid pod?"] },
        },
      },
      n2: {
        message: {
          author: { role: "assistant" },
          create_time: 1676368205,
          content: { content_type: "text", parts: ["A personal online datastore."] },
        },
      },
      sys: {
        message: { author: { role: "system" }, content: { parts: ["You are helpful"] } },
      },
    },
  },
  {
    title: "Untitled",
    mapping: {
      a: {
        message: {
          author: { role: "user" },
          create_time: 1,
          content: { parts: ["hi"] },
        },
      },
    },
  },
]);

describe("chatgpt file adapter", () => {
  it("writes each conversation as a schema:TextDigitalDocument in Documents", async () => {
    const { pod, report } = await fileImport(
      chatgptFileAdapter,
      memoryFile("conversations.json", SAMPLE, "application/json"),
    );
    expect(report.categories).toEqual(["documents"]);
    const ds = pod.dataset(DOC);
    const types = [...ds].filter(
      (q) => q.object.value === CLASSES.TextDigitalDocument && q.predicate.value.endsWith("type"),
    );
    expect(types).toHaveLength(2);
  });

  it("flattens the message tree in time order, skipping system messages", async () => {
    const { pod } = await fileImport(
      chatgptFileAdapter,
      memoryFile("c.json", SAMPLE, "application/json"),
    );
    const ds = pod.dataset(DOC);
    const nameQuad = [...ds].find(
      (q) => q.predicate.value === "https://schema.org/name" && q.object.value === "Solid pods explained",
    );
    const td = new TextDocument(nameQuad!.subject.value, ds, DataFactory);
    expect(td.text).toBe("You: What is a Solid pod?\n\nChatGPT: A personal online datastore.");
    expect(td.dateCreated?.toISOString()).toBe("2023-02-14T09:50:00.000Z");
  });

  it("registers TextDigitalDocument in the type index", async () => {
    const { pod, report } = await fileImport(
      chatgptFileAdapter,
      memoryFile("c.json", SAMPLE, "application/json"),
    );
    expect(pod.get(report.indexUrl)).toContain(CLASSES.TextDigitalDocument);
  });
});

describe("parseChatgptExport", () => {
  it("returns [] for invalid JSON", () => {
    expect(parseChatgptExport("{not json")).toEqual([]);
  });
  it("accepts the { conversations: [...] } wrapper", () => {
    const wrapped = JSON.stringify({ conversations: [{ title: "T", mapping: {} }] });
    expect(parseChatgptExport(wrapped)).toHaveLength(1);
  });
  it("respects the limit", () => {
    expect(parseChatgptExport(SAMPLE, 1)).toHaveLength(1);
  });
});
