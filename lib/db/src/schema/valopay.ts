import { pgTable, text, jsonb, timestamp, bigint, uniqueIndex, index, check, primaryKey } from "drizzle-orm/pg-core";
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
}, t => [
  // A workspace's lenders: listing and counting them, the expiry sweep, the staff directory and row-security scope (migration 007).
  index("valopay_merchants_workspace").on(t.workspaceId, t.id),
]);
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
  index("valopay_records_lender_kind_page").on(t.merchantId, t.kind, t.createdAt, t.id),
  index("valopay_records_lender_kind_status_page").on(t.merchantId, t.kind, t.status, t.createdAt, t.id),
  index("valopay_records_lender_customer").on(t.merchantId, t.customerId, t.createdAt, t.id),
  index("valopay_records_lender_kind_updated").on(t.merchantId, t.kind, t.updatedAt),
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

/** Private recovery requests are never exposed through the generic records API. */
export const operations = pgTable('valopay_operations', {
  id: text('id').primaryKey(), merchantId: text('merchant_id').notNull().references(() => merchants.id, { onDelete: 'cascade' }),
  owner: text('owner').notNull(), actor: text('actor').notNull(), role: text('role').notNull(),
  requestKey: text('request_key').notNull(), requestHash: text('request_hash').notNull(), request: jsonb('request').notNull(),
  label: text('label').notNull(), status: text('status').notNull().default('pending'), receipt: jsonb('receipt'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [index('valopay_operations_owner_page').on(t.merchantId, t.owner, t.createdAt, t.id),
  // The pending-request limit counts only a person's pending entries (migration 007).
  index('valopay_operations_pending').on(t.merchantId, t.owner).where(sql`${t.status} = 'pending'`),
  check('valopay_operation_status', sql`${t.status} IN ('pending','completed','cancelled')`)]);

export const teams = pgTable('valopay_teams', {
  workspaceId: text('workspace_id').primaryKey().references(() => workspaces.id),
  organizationId: text('organization_id').notNull().unique(), name: text('name').notNull(),
});
export const staffMemberships = pgTable('valopay_staff_memberships', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => teams.workspaceId),
  userId: text('user_id').notNull(), displayName: text('display_name').notNull(), role: text('role').notNull(),
  status: text('status').notNull().default('active'), expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('valopay_staff_workspace_user').on(t.workspaceId, t.userId),
  check('valopay_staff_status', sql`${t.status} IN ('active','suspended','revoked')`),
  check('valopay_staff_role', sql`${t.role} IN ('Admin','Operations','Finance','Compliance reviewer','Read-only')`)]);
export const staffInvitations = pgTable('valopay_staff_invitations', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => teams.workspaceId),
  email: text('email').notNull(), role: text('role').notNull(), tokenHash: text('token_hash').notNull().unique(),
  invitedBy: text('invited_by').notNull(), status: text('status').notNull().default('pending'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [check('valopay_invitation_status', sql`${t.status} IN ('pending','accepted','revoked')`)]);
export const staffEvents = pgTable('valopay_staff_events', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => teams.workspaceId),
  actor: text('actor').notNull(), action: text('action').notNull(), subject: text('subject').notNull(), detail: jsonb('detail').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** An active non-administrator membership has access only to named lenders. */
export const staffLenderAccess = pgTable('valopay_staff_lender_access', {
  membershipId: text('membership_id').notNull().references(() => staffMemberships.id, { onDelete: 'cascade' }),
  merchantId: text('merchant_id').notNull().references(() => merchants.id, { onDelete: 'cascade' }),
  grantedBy: text('granted_by').notNull(),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.membershipId, table.merchantId] }),
  index('valopay_staff_lender_access_lender').on(table.merchantId, table.membershipId)]);
