import assert from "node:assert/strict";
import { settingsRevision, assertRecordVersion, assertSettingsVersion, advanceRecordVersions } from "../src/lib/edit-versions.js";
import { seedMerchant } from "../src/lib/valopay-seed.js";

const state = seedMerchant("version-tests", false);
const record = state.records.find(record => record.kind === "customers")!;
assert.doesNotThrow(() => assertRecordVersion(record, record.updatedAt));
assert.doesNotThrow(() => assertRecordVersion(record, undefined));
assert.throws(() => assertRecordVersion(record, "not-a-time"), (error: any) => error.status === 400);
assert.throws(() => assertRecordVersion(record, "2000-01-01T00:00:00Z"), (error: any) => error.status === 409 && /Refresh the record/.test(error.message));
const revision = settingsRevision(state.settings);
assert.doesNotThrow(() => assertSettingsVersion(state.settings, revision));
assert.doesNotThrow(() => assertSettingsVersion(state.settings, undefined));
assert.equal(settingsRevision({ ...state.settings, nextCloseAt: "2028-01-01T07:00:00.000Z", lastCloseAt: "2027-01-01T07:00:00.000Z" }), revision, "scheduler activity does not invalidate an edit");
assert.throws(() => assertSettingsVersion({ ...state.settings, contactRoute: "new support route" }, revision), (error: any) => error.status === 409);

const changed = structuredClone(state), edited = changed.records.find(row => row.id === record.id)!;
edited.name = "Revised customer";
advanceRecordVersions(state, changed, record.updatedAt);
assert.equal(Date.parse(edited.updatedAt), Date.parse(record.updatedAt) + 1, "same-millisecond updates are distinct");
advanceRecordVersions(state, changed, record.updatedAt);
assert.equal(Date.parse(edited.updatedAt), Date.parse(record.updatedAt) + 1, "checking again does not advance twice");
for (const unchanged of changed.records.filter(row => row.id !== record.id)) assert.deepEqual(unchanged, state.records.find(row => row.id === unchanged.id));
const late = structuredClone(changed), lateRecord = late.records.find(row => row.id === record.id)!;
lateRecord.name = "A later change";
advanceRecordVersions(changed, late, "2000-01-01T00:00:00.000Z");
assert.equal(Date.parse(lateRecord.updatedAt), Date.parse(edited.updatedAt) + 1, "a waiting transaction cannot move a revision backward");
assert.throws(() => assertRecordVersion(lateRecord, edited.updatedAt), (error: any) => error.status === 409);
console.log("Edit versions passed: stale records/settings rejected, scheduler cursor excluded, strictly increasing versions.");
