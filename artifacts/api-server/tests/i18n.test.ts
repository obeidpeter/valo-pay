// The market's letters and conventions: a search that ignores case and marks,
// counts with their nouns in the right number, and exports that spell Yoruba
// and Igbo names as their bearers write them, in the PDF and in a spreadsheet.
import assert from "node:assert/strict";

// The store and export modules reach the database module, which insists on an address before anything here runs; nothing in this file touches a database.
process.env["DATABASE_URL"] ??= "postgres://postgres@127.0.0.1:1/valopay-unused";
const { counted } = await import("@workspace/valopay-schema");
const { foldForSearch, pageRecords } = await import("../src/lib/valopay-list.js");
const { seedMerchant } = await import("../src/lib/valopay-seed.js");
const { buildDisputePack, packFonts, renderDisputePackPdf } = await import("../src/lib/valopay-packs.js");
const { buildExportBytes } = await import("../src/lib/valopay-exports.js");
const { importCsv } = await import("../src/lib/valopay-import.js");
const { ctxAt, decodePdfText } = await import("./helpers.js");

let checks = 0;
const state = seedMerchant("i18n-merchant", false);
const ctx = ctxAt("2027-07-01T08:00:00.000Z", "Finance");
const customers = state.records.filter((record) => record.kind === "customers");
const names = customers.map((record) => record.name);

// ---- Names carry their marks, and a search finds them however it is typed ----
for (const name of ["Chiamaka Ọbi", "Túndé Bakare", "Dami Adéyẹmí", "Ṣeyi Ajayi"]) assert.ok(names.includes(name), `seeded ${name}`);
assert.equal(foldForSearch("Ọkọnkwọ"), "okonkwo");
assert.equal(foldForSearch("ADÉYẸMÍ"), "adeyemi");
const found = (search: string) => pageRecords(customers, { search }).items.map((record) => record.name);
assert.deepEqual(found("obi"), ["Chiamaka Ọbi"], "unmarked letters find the marked name");
assert.deepEqual(found("ỌBI"), ["Chiamaka Ọbi"], "marked capitals find it too");
assert.deepEqual(found("adeyemi"), ["Dami Adéyẹmí"]);
assert.deepEqual(found("Adéyẹmí"), ["Dami Adéyẹmí"]);
assert.deepEqual(found("seyi"), ["Ṣeyi Ajayi"]);
assert.deepEqual(found("tunde"), ["Túndé Bakare"]);
assert.deepEqual(found("okonkwo"), ["Ada Okonkwo"], "a plain name still matches only itself");
checks += 13;

// ---- Counts read with their nouns ----
assert.equal(counted(1, "entry", "entries"), "1 entry");
assert.equal(counted(0, "item"), "0 items");
assert.equal(counted(2, "observation"), "2 observations");
assert.equal(counted(1234, "record"), "1,234 records");
checks += 4;

// ---- The PDF spells the names: its own typeface, not a WinAnsi standard font ----
const fonts = packFonts();
assert.ok(fonts.regular.length > 50_000 && fonts.bold.length > 50_000, "both weights of the typeface are shipped");
for (const name of ["Chiamaka Ọbi", "Dami Adéyẹmí", "Ṣeyi Ajayi"]) {
  const customer = customers.find((record) => record.name === name)!;
  const pdf = await renderDisputePackPdf(buildDisputePack(state, ctx, customer.id), { compress: false });
  const decoded = decodePdfText(pdf);
  assert.ok(decoded.includes(name), `the pack for ${name} prints the name as written`);
  assert.ok(!decoded.includes("?k") && !decoded.includes("�"), `no letter of ${name} is replaced`);
  assert.match(pdf.toString("latin1"), /\/BaseFont \/[A-Z]{6}\+ValoPackSans-(Regular|Bold)/);
}
checks += 10;

// ---- Spreadsheet exports: UTF-8 with the byte order mark, and the importer accepts one ----
const csv = await buildExportBytes(state, ctx, { kind: "customers", format: "csv" });
const csvText = csv.bytes.toString("utf8");
assert.ok(csvText.startsWith("﻿"), "the CSV starts with the byte order mark");
assert.ok(csvText.includes("Dami Adéyẹmí") && csvText.includes("Chiamaka Ọbi"), "the CSV carries the names unchanged");
assert.equal(csv.contentType, "text/csv; charset=utf-8");
const preview = importCsv(state, ctx, { kind: "customers", syntheticOnly: true, commit: false, csv: "﻿name,reference,consentProvenance,bankName,accountMasked,phoneMasked\r\nỌlá Adébáyọ̀,IMP-C001,Synthetic imported consent,Sandbox Bank,•••• 0001,+234 ••• ••01\r\n" });
assert.equal((preview as { valid: number }).valid, 1, "a file saved by a spreadsheet program, mark and all, is read");
checks += 4;

console.log(`Internationalisation tests passed (${checks} checks): accent-insensitive search, counts with nouns, the pack's own typeface spelling Yoruba and Igbo names, CSV byte order mark in and out.`);
