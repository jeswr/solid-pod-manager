import { describe, it, expect } from "vitest";
import { DataFactory } from "n3";
import { fileImport, memoryFile, TEST_POD_ROOT } from "../core/testing.js";
import { Book, CLASSES } from "../core/vocab.js";
import { cleanIsbn, goodreadsFileAdapter, parseDateOnly } from "./file-adapter.js";

const DOC = `${TEST_POD_ROOT}integrations/goodreads/documents/goodreads-library.ttl`;

const SAMPLE = `Book Id,Title,Author,ISBN,ISBN13,My Rating,Exclusive Shelf,Date Added
12345,Dune,Frank Herbert,"=""0441013597""","=""9780441013593""",5,read,2022/01/15
67890,Project Hail Mary,Andy Weir,"=""""","=""9780593135204""",4,read,2023/03/02
11111,The Pragmatic Programmer,"Hunt, Andrew","=""""","=""""",0,to-read,2024/05/01`;

describe("goodreads file adapter", () => {
  it("writes each book as a schema:Book in Documents", async () => {
    const { pod, report } = await fileImport(
      goodreadsFileAdapter,
      memoryFile("goodreads_library_export.csv", SAMPLE, "text/csv"),
    );
    expect(report.categories).toEqual(["documents"]);
    const ds = pod.dataset(DOC);
    const types = [...ds].filter(
      (q) => q.object.value === CLASSES.Book && q.predicate.value.endsWith("type"),
    );
    expect(types).toHaveLength(3);
  });

  it("captures author, rating, shelf and a cleaned ISBN", async () => {
    const { pod } = await fileImport(
      goodreadsFileAdapter,
      memoryFile("lib.csv", SAMPLE, "text/csv"),
    );
    const ds = pod.dataset(DOC);
    const nameQuad = [...ds].find(
      (q) => q.predicate.value === "https://schema.org/name" && q.object.value === "Dune",
    );
    const book = new Book(nameQuad!.subject.value, ds, DataFactory);
    expect(book.author).toBe("Frank Herbert");
    expect(book.isbn).toBe("9780441013593");
    expect(book.ratingValue).toBe(5);
    expect(book.readingStatus).toBe("read");
    expect(book.dateCreated?.toISOString().slice(0, 10)).toBe("2022-01-15");
  });

  it("omits a zero rating and an empty ISBN", async () => {
    const { pod } = await fileImport(
      goodreadsFileAdapter,
      memoryFile("lib.csv", SAMPLE, "text/csv"),
    );
    const ds = pod.dataset(DOC);
    const nameQuad = [...ds].find(
      (q) => q.predicate.value === "https://schema.org/name" && q.object.value === "The Pragmatic Programmer",
    );
    const book = new Book(nameQuad!.subject.value, ds, DataFactory);
    expect(book.ratingValue).toBeUndefined();
    expect(book.isbn).toBeUndefined();
    expect(book.author).toBe("Hunt, Andrew");
    expect(book.readingStatus).toBe("to-read");
  });

  it("registers Book in the type index", async () => {
    const { pod, report } = await fileImport(
      goodreadsFileAdapter,
      memoryFile("lib.csv", SAMPLE, "text/csv"),
    );
    expect(pod.get(report.indexUrl)).toContain(CLASSES.Book);
  });
});

describe("cleanIsbn", () => {
  it("unwraps the Goodreads ='...' form", () => {
    expect(cleanIsbn('="9780441013593"')).toBe("9780441013593");
  });
  it("returns undefined for empty wrappers", () => {
    expect(cleanIsbn('=""')).toBeUndefined();
    expect(cleanIsbn(undefined)).toBeUndefined();
  });
});

describe("parseDateOnly", () => {
  it("parses YYYY/MM/DD", () => {
    expect(parseDateOnly("2022/01/15")?.toISOString().slice(0, 10)).toBe("2022-01-15");
  });
});
