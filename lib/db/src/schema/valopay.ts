import { pgTable, text, jsonb, timestamp, bigint, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";

export const workspaces = pgTable("valopay_workspaces", {
  id: text("id").primaryKey(),
  principalHash: text("principal_hash").notNull().unique(),
  role: text("role").notNull().default("Admin"),
  createdAt: timestamp("created_at", {withTimezone:true}).notNull().defaultNow(),
});
export const merchants = pgTable("valopay_merchants", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(()=>workspaces.id),
  info: jsonb("info").notNull(),
  settings: jsonb("settings").notNull(),
});
export const records = pgTable("valopay_records", {
  id: text("id").primaryKey(),
  merchantId: text("merchant_id").notNull().references(()=>merchants.id),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  reference: text("reference").notNull().default(""),
  amountKobo: bigint("amount_kobo", {mode:"number"}).notNull().default(0),
  customerId: text("customer_id").notNull().default(""),
  data: jsonb("data").notNull(),
  createdAt: timestamp("created_at",{withTimezone:true}).notNull().defaultNow(),
  updatedAt: timestamp("updated_at",{withTimezone:true}).notNull().defaultNow(),
}, t => [
  uniqueIndex("valopay_unique_due_reference")
    .on(t.merchantId, t.reference)
    .where(sql`${t.kind} = 'due-items' AND ${t.reference} <> ''`),
  uniqueIndex("valopay_unique_observation")
    .on(t.merchantId, sql`(${t.data}->>'source')`, sql`(${t.data}->>'eventId')`)
    .where(sql`${t.kind} = 'observations' AND ${t.data}->>'eventId' IS NOT NULL`),
  uniqueIndex("valopay_one_inflight")
    .on(t.merchantId, sql`(${t.data}->>'dueItemId')`)
    .where(sql`${t.kind} = 'attempts' AND ${t.status} IN ('scheduled','sent','unknown')`),
  check("valopay_money_integer", sql`${t.amountKobo} >= 0 AND ${t.amountKobo} <= 9007199254740991`),
  check("valopay_ticket_floor", sql`${t.kind} <> 'due-items' OR ${t.amountKobo} >= 500000`),
]);
export const idempotency = pgTable("valopay_idempotency", {
  id: text("id").primaryKey(),
  merchantId: text("merchant_id").notNull().references(()=>merchants.id),
  requestHash: text("request_hash").notNull(),
  response: jsonb("response").notNull(),
  createdAt: timestamp("created_at",{withTimezone:true}).notNull().defaultNow(),
},t=>[uniqueIndex("valopay_idempotency_tenant_key").on(t.merchantId,t.id)]);
export const insertValopayRecordSchema = createInsertSchema(records);
export type ValopayRecordRow = typeof records.$inferSelect;