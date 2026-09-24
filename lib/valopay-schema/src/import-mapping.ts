import { recordDataSchemas } from "./records";

/*
 * What a CSV column can fill when it is imported, shared by the API's check
 * and the console's mapping. The importer keeps a column that names no field
 * as extra detail on the record, which nothing reads, so a column the person
 * meant as a name must be mapped to it.
 */

/** The record's own fields a column can fill, whatever the kind (a customer has no customer to link to). */
const recordFields = ["name", "reference", "status", "amountKobo", "customerId"] as const;
/** The fields a column of this import kind can fill: the record's own and its kind's data fields. */
export function importFieldsOf(kind: string): string[] {
  const schema = recordDataSchemas[kind as keyof typeof recordDataSchemas];
  const own = recordFields.filter((field) => !(kind === "customers" && field === "customerId"));
  return [...own, ...(schema ? Object.keys(schema.shape).filter((field) => field !== "synthetic") : [])];
}
/** A header folded for comparison: case, spaces and punctuation ignored, so "Full Name" and "full_name" are one. */
const fold = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
/** Common headers that do not fold to their field's name. */
const aliases: Record<string, string> = {
  fullname: "name", customername: "name", payername: "name", accountname: "name", borrowername: "name",
  ref: "reference", amount: "amountKobo", due: "dueDate",
  mandate: "mandateId", mandatereference: "mandateId", instalment: "dueItemId", instalmentreference: "dueItemId",
};
/**
 * The field a column's header suggests for this kind, or undefined: a header
 * that folds to a field's name, or a common spelling such as full_name for the
 * name. A customer reference is the customer's own reference in a customer
 * file and the link to the customer in any other.
 */
export function suggestImportField(kind: string, column: string): string | undefined {
  const folded = fold(column), fields = importFieldsOf(kind);
  const exact = fields.find((field) => fold(field) === folded);
  if (exact) return exact;
  const field = ["customerreference", "customerref"].includes(folded) ? (kind === "customers" ? "reference" : "customerId") : aliases[folded];
  return field && fields.includes(field) ? field : undefined;
}
