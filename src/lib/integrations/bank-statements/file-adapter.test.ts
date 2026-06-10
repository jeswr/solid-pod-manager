import { describe, it, expect } from "vitest";
import { DataFactory } from "n3";
import { fileImport, memoryFile, TEST_POD_ROOT } from "../core/testing.js";
import { CLASSES, Invoice } from "../core/vocab.js";
import {
  bankStatementsFileAdapter,
  normaliseAmount,
  parseBankCsv,
  parseOfx,
  parseOfxDate,
} from "./file-adapter.js";

const DOC = `${TEST_POD_ROOT}integrations/bank-statements/finance/bank-transactions.ttl`;

const CSV_SIGNED = `Date,Description,Amount
2023-02-14,COFFEE SHOP,-3.50
2023-02-15,SALARY,2500.00`;

const CSV_DEBIT_CREDIT = `Transaction Date,Payee,Money Out,Money In
14/02/2023,GROCERIES,42.10,
15/02/2023,REFUND,,9.99`;

const OFX = `OFXHEADER:100
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>GBP
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20230214120000<TRNAMT>-3.50<NAME>COFFEE SHOP</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20230215<TRNAMT>2500.00<NAME>SALARY</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

describe("bank-statements file adapter", () => {
  it("imports a signed-amount CSV as schema:Invoice in Finance", async () => {
    const { pod, report } = await fileImport(
      bankStatementsFileAdapter,
      memoryFile("statement.csv", CSV_SIGNED, "text/csv"),
    );
    expect(report.categories).toEqual(["finance"]);
    const ds = pod.dataset(DOC);
    const types = [...ds].filter(
      (q) => q.object.value === CLASSES.Invoice && q.predicate.value.endsWith("type"),
    );
    expect(types).toHaveLength(2);
    const coffee = [...ds].find(
      (q) => q.predicate.value === "https://schema.org/name" && q.object.value === "COFFEE SHOP",
    );
    const inv = new Invoice(coffee!.subject.value, ds, DataFactory);
    expect(inv.totalPaymentDue).toBe("-3.50");
    expect(inv.dateCreated?.toISOString().slice(0, 10)).toBe("2023-02-14");
  });

  it("handles separate debit/credit columns", async () => {
    const txns = parseBankCsv(CSV_DEBIT_CREDIT);
    expect(txns).toHaveLength(2);
    expect(txns[0]).toMatchObject({ description: "GROCERIES", amount: "-42.1" });
    expect(txns[1]).toMatchObject({ description: "REFUND", amount: "9.99" });
    expect(txns[0].date?.toISOString().slice(0, 10)).toBe("2023-02-14");
  });

  it("imports an OFX file via the STMTTRN blocks", async () => {
    const { pod } = await fileImport(
      bankStatementsFileAdapter,
      memoryFile("statement.ofx", OFX, "application/x-ofx"),
    );
    const ds = pod.dataset(DOC);
    const salary = [...ds].find(
      (q) => q.predicate.value === "https://schema.org/name" && q.object.value === "SALARY",
    );
    const inv = new Invoice(salary!.subject.value, ds, DataFactory);
    expect(inv.totalPaymentDue).toBe("2500.00");
    expect(inv.priceCurrency).toBe("GBP");
    expect(inv.dateCreated?.toISOString().slice(0, 10)).toBe("2023-02-15");
  });

  it("registers Invoice in the type index", async () => {
    const { pod, report } = await fileImport(
      bankStatementsFileAdapter,
      memoryFile("s.csv", CSV_SIGNED, "text/csv"),
    );
    expect(pod.get(report.indexUrl)).toContain(CLASSES.Invoice);
  });
});

describe("normaliseAmount", () => {
  it("strips symbols and keeps the sign", () => {
    expect(normaliseAmount("£1,234.56")).toBe("1234.56");
    expect(normaliseAmount("-$3.50")).toBe("-3.50");
  });
  it("converts parenthesised negatives", () => {
    expect(normaliseAmount("(12.50)")).toBe("-12.50");
  });
});

describe("parseOfx / parseOfxDate", () => {
  it("parses YYYYMMDD with optional time", () => {
    expect(parseOfxDate("20230214120000")?.toISOString().slice(0, 10)).toBe("2023-02-14");
    expect(parseOfxDate(undefined)).toBeUndefined();
  });
  it("extracts the transaction blocks", () => {
    expect(parseOfx(OFX)).toHaveLength(2);
  });
});
