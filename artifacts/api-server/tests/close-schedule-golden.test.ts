// Golden tests for the scheduled daily close: the configurable WAT time
// (REC-01, default 07:00), the cursor every close moves, a manual close before
// or after the time, a close that runs late after an outage (NFR-AVA-02) and
// the missed-close alert (NFR-OBS-02).
import assert from "node:assert/strict";
import { closeRules, closeTimeOf, isCloseTime, nextCloseInstant } from "@workspace/valopay-schema";
import { ctxAt, liveFixture, wat } from "./helpers.js";
import { executeAction, runDailyClose } from "../src/domain/actions.js";
import { closeSchedule, rescheduleAfterSettings, scheduledCloseDue, storedCloseCursor } from "../src/domain/close.js";
import { buildAlerts } from "../src/domain/alerts.js";
import { buildOverview, buildReports } from "../src/domain/reports.js";
import { recordsOf } from "../src/domain/records.js";
import { seedMerchant } from "../src/lib/valopay-seed.js";

let checks = 0;
const quietDeadlines = (state: ReturnType<typeof seedMerchant>) => { for (const exception of recordsOf(state, "exceptions")) exception.data.dueBy = "2028-01-01T00:00:00.000Z"; };

// ---------- The schedule arithmetic: WAT wall clock, strictly after now ----------
{
  assert.equal(closeRules.defaultTime, "07:00", "REC-01 default");
  assert.equal(closeRules.lateAfterMinutes, 30, "7.5: a close has 30 minutes");
  assert.equal(nextCloseInstant(wat("2027-06-28T06:59:59")), wat("2027-06-28T07:00:00"), "before the time: today");
  assert.equal(nextCloseInstant(wat("2027-06-28T07:00:00")), wat("2027-06-29T07:00:00"), "exactly at the time: tomorrow, the next instant is strictly after now");
  assert.equal(nextCloseInstant(wat("2027-06-28T15:30:00")), wat("2027-06-29T07:00:00"), "after the time: tomorrow");
  assert.equal(nextCloseInstant(wat("2027-06-28T23:50:00"), "00:15"), wat("2027-06-29T00:15:00"), "a time just past WAT midnight, computed on the WAT date not the UTC date");
  assert.equal(nextCloseInstant(wat("2027-06-30T00:30:00"), "00:15"), wat("2027-07-01T00:15:00"), "rolls across a month end");
  assert.equal(nextCloseInstant(wat("2027-12-31T09:00:00"), "07:00"), wat("2028-01-01T07:00:00"), "and a year end");
  assert.equal(nextCloseInstant(Date.parse(wat("2027-06-28T06:00:00")), "06:00"), wat("2027-06-29T06:00:00"), "an epoch-millisecond instant is accepted");
  assert.equal(nextCloseInstant(wat("2027-06-28T06:00:00"), "7am"), wat("2027-06-28T07:00:00"), "a malformed time falls back to the default, an hour later that day");
  assert.throws(() => nextCloseInstant("yesterday"), /valid instant/);
  checks += 11;
  assert.equal(isCloseTime("07:00"), true); assert.equal(isCloseTime("23:59"), true); assert.equal(isCloseTime("00:00"), true);
  assert.equal(isCloseTime("24:00"), false); assert.equal(isCloseTime("7:00"), false); assert.equal(isCloseTime("07:60"), false); assert.equal(isCloseTime(7), false);
  assert.equal(closeTimeOf({ closeTime: "09:30" }), "09:30"); assert.equal(closeTimeOf({ closeTime: "" }), "07:00"); assert.equal(closeTimeOf({}), "07:00"); assert.equal(closeTimeOf(undefined), "07:00");
  checks += 11;
}

// ---------- The seed carries the time and the switch; the cursor is set by the repository from the database clock ----------
{
  const state = seedMerchant("schedule-seed");
  assert.equal(state.settings.closeTime, "07:00"); assert.equal(state.settings.scheduledCloseEnabled, true);
  assert.equal(storedCloseCursor(state), null, "no cursor until the repository seeds one");
  const view = closeSchedule(state, wat("2027-06-28T09:00:00"));
  assert.equal(view.nextAt, wat("2027-06-29T07:00:00"), "without a cursor the next instant is derived for display");
  assert.equal(view.missed, false); assert.equal(view.lastAt, null); assert.equal(view.lastTrigger, null);
  assert.equal(scheduledCloseDue(state, wat("2027-06-29T09:00:00")), false, "a merchant without a cursor is never due");
  state.settings.nextCloseAt = "not an instant";
  assert.equal(storedCloseCursor(state), null, "a malformed cursor is ignored");
  checks += 9;
}

// ---------- A manual close before the time leaves the scheduled close pending; the scheduled close runs on time; a manual close after covers a missed one ----------
{
  const { state } = liveFixture({ merchantId: "schedule-manual", withFailure: false });
  quietDeadlines(state);
  state.settings.nextCloseAt = wat("2027-06-28T07:00:00");
  const early = executeAction(state, ctxAt(wat("2027-06-28T06:30:00"), "Finance"), { action: "daily_close" }).record!;
  assert.equal(early.name, "Daily close 2027-06-28");
  assert.deepEqual(early.data.schedule, { trigger: "manual", scheduledFor: null, delayMinutes: null, late: false, nextAt: wat("2027-06-28T07:00:00") }, "the 07:00 close is still to come");
  assert.equal(state.settings.nextCloseAt, wat("2027-06-28T07:00:00"), "a manual close before the time does not move the cursor past it");
  assert.equal(scheduledCloseDue(state, wat("2027-06-28T06:59:00")), false);
  assert.equal(scheduledCloseDue(state, wat("2027-06-28T07:00:00")), true, "due at the instant itself");
  checks += 5;

  const onTime = runDailyClose(state, ctxAt(wat("2027-06-28T07:00:30"), "Operations"), "scheduled");
  assert.equal(onTime.record!.name, "Daily close 2027-06-28 · scheduled");
  assert.deepEqual(onTime.record!.data.schedule, { trigger: "scheduled", scheduledFor: wat("2027-06-28T07:00:00"), delayMinutes: 0, late: false, nextAt: wat("2027-06-29T07:00:00") });
  assert.equal(onTime.message, "Scheduled daily close completed. No data was fetched from the provider or sent to the loan management system.");
  assert.deepEqual(onTime.data.schedule, onTime.record!.data.schedule, "the action result carries the schedule block");
  assert.equal(state.settings.nextCloseAt, wat("2027-06-29T07:00:00"), "the cursor moved to the next 07:00");
  assert.equal(scheduledCloseDue(state, wat("2027-06-28T07:01:00")), false, "not due again until tomorrow");
  assert.equal(onTime.record!.data.period.from, early.data.closedAt, "the period starts where the manual close ended");
  assert.equal(closeSchedule(state, wat("2027-06-28T08:00:00")).lastTrigger, "scheduled");
  checks += 8;

  // The next day the platform is down at 07:00 and a person closes at 07:45: that manual close covers the missed instant, late.
  const catchUp = executeAction(state, ctxAt(wat("2027-06-29T07:45:00"), "Admin"), { action: "daily_close" }).record!;
  assert.deepEqual(catchUp.data.schedule, { trigger: "manual", scheduledFor: wat("2027-06-29T07:00:00"), delayMinutes: 45, late: true, nextAt: wat("2027-06-30T07:00:00") });
  assert.equal(state.settings.nextCloseAt, wat("2027-06-30T07:00:00"));
  assert.equal(scheduledCloseDue(state, wat("2027-06-29T08:00:00")), false, "the scheduler has nothing left to run today");
  checks += 3;
}

// ---------- Recovery: a scheduled close missed while the platform was down runs late and says so (NFR-AVA-02) ----------
{
  const { state } = liveFixture({ merchantId: "schedule-late", withFailure: false });
  quietDeadlines(state);
  state.settings.nextCloseAt = wat("2027-06-28T07:00:00");
  const late = runDailyClose(state, ctxAt(wat("2027-06-28T15:10:00"), "Operations"), "scheduled");
  assert.equal(late.record!.data.schedule.delayMinutes, 490); assert.equal(late.record!.data.schedule.late, true);
  assert.equal(late.message, "Scheduled daily close completed 490 minutes after its 07:00 WAT time. No data was fetched from the provider or sent to the loan management system.");
  assert.equal(late.record!.data.report.alerts.some((alert: { key: string }) => alert.key === "close_missed"), true, "the report freezes the missed-close alert as it stood when the late close started");
  assert.equal(state.settings.nextCloseAt, wat("2027-06-29T07:00:00"), "the cursor moves to the next day, not to another close today");
  checks += 5;
  // Exactly 30 minutes is not late; 31 is.
  state.settings.nextCloseAt = wat("2027-06-29T07:00:00");
  assert.equal(runDailyClose(state, ctxAt(wat("2027-06-29T07:30:00"), "Operations"), "scheduled").record!.data.schedule.late, false);
  state.settings.nextCloseAt = wat("2027-06-30T07:00:00");
  const justLate = runDailyClose(state, ctxAt(wat("2027-06-30T07:31:00"), "Operations"), "scheduled").record!.data.schedule;
  assert.equal(justLate.late, true); assert.equal(justLate.delayMinutes, 31);
  checks += 3;
}

// ---------- The alert, the schedule view, the overview and the report ----------
{
  const { state } = liveFixture({ merchantId: "schedule-alert", withFailure: false });
  quietDeadlines(state);
  state.settings.nextCloseAt = wat("2027-06-28T07:00:00");
  const keys = (now: string) => buildAlerts(state, now).map((alert) => alert.key);
  assert.deepEqual(keys(wat("2027-06-28T07:30:00")), ["close_overdue"], "30 minutes past its time is not yet missed");
  assert.deepEqual(keys(wat("2027-06-28T07:31:00")), ["close_missed", "close_overdue"], "31 minutes past: missed, high before medium");
  const alert = buildAlerts(state, wat("2027-06-28T09:00:00")).find((item) => item.key === "close_missed")!;
  assert.equal(alert.severity, "high"); assert.equal(alert.since, wat("2027-06-28T07:00:00")); assert.match(alert.detail, /07:00 WAT is 120 minutes late/);
  checks += 5;
  state.settings.scheduledCloseEnabled = false;
  assert.deepEqual(keys(wat("2027-06-28T09:00:00")), ["close_overdue"], "no missed-close alert when the automatic close is off");
  assert.equal(scheduledCloseDue(state, wat("2027-06-28T09:00:00")), false, "and nothing is due");
  assert.equal(buildOverview(state, wat("2027-06-28T09:00:00")).nextClose, "", "the overview shows no next close when the automatic close is off");
  state.settings.scheduledCloseEnabled = true;
  assert.deepEqual(closeSchedule(state, wat("2027-06-28T09:00:00")), { time: "07:00", enabled: true, nextAt: wat("2027-06-28T07:00:00"), missed: true, overdueMinutes: 120, lateAfterMinutes: 30, lastAt: null, lastTrigger: null });
  checks += 4;
  // A configured time other than the default: the route recomputes the cursor from the new time.
  state.settings.closeTime = "09:30";
  state.settings.nextCloseAt = nextCloseInstant(wat("2027-06-28T09:00:00"), closeTimeOf(state.settings));
  assert.equal(state.settings.nextCloseAt, wat("2027-06-28T09:30:00"));
  const overview = buildOverview(state, wat("2027-06-28T09:00:00"));
  assert.equal(overview.nextClose, wat("2027-06-28T09:30:00")); assert.equal(overview.closeTime, "09:30");
  assert.equal(buildReports(state, wat("2027-06-28T09:00:00")).operational.closeSchedule.nextAt, wat("2027-06-28T09:30:00"));
  runDailyClose(state, ctxAt(wat("2027-06-28T09:30:00"), "Operations"), "scheduled");
  const after = closeSchedule(state, wat("2027-06-28T09:31:00"));
  assert.equal(after.lastTrigger, "scheduled"); assert.equal(after.lastAt, wat("2027-06-28T09:30:00")); assert.equal(after.nextAt, wat("2027-06-29T09:30:00")); assert.equal(after.missed, false);
  assert.equal(recordsOf(state, "closes").at(-1)!.data.schedule!.nextAt, wat("2027-06-29T09:30:00"));
  checks += 9;
}

// ---------- Settings changes: only a changed time or a switch-on moves the cursor; an unchanged save leaves a missed close pending ----------
{
  const state = seedMerchant("schedule-settings");
  const now = wat("2027-06-28T09:00:00");
  state.settings.nextCloseAt = wat("2027-06-28T07:00:00"); // missed two hours ago
  const previous = () => ({ time: closeTimeOf(state.settings), enabled: state.settings.scheduledCloseEnabled !== false });
  let before = previous();
  Object.assign(state.settings, { closeTime: "07:00", scheduledCloseEnabled: true, contactRoute: "Call the branch" });
  assert.equal(rescheduleAfterSettings(state, before, now), false, "the console saves the whole form; unchanged close fields do not move the cursor");
  assert.equal(state.settings.nextCloseAt, wat("2027-06-28T07:00:00"), "the missed close is still pending for the scheduler to catch up");
  before = previous(); state.settings.closeTime = "09:30";
  assert.equal(rescheduleAfterSettings(state, before, now), true, "a new time reschedules");
  assert.equal(state.settings.nextCloseAt, wat("2027-06-28T09:30:00"));
  before = previous(); state.settings.scheduledCloseEnabled = false;
  assert.equal(rescheduleAfterSettings(state, before, now), false, "switching off leaves the cursor");
  assert.equal(scheduledCloseDue(state, wat("2027-06-28T10:00:00")), false, "but nothing is due while off");
  state.settings.nextCloseAt = wat("2027-06-20T09:30:00"); // a week passes while off
  before = previous(); state.settings.scheduledCloseEnabled = true;
  assert.equal(rescheduleAfterSettings(state, before, now), true, "switching on restarts from the next occurrence, not the stale cursor");
  assert.equal(state.settings.nextCloseAt, wat("2027-06-28T09:30:00"));
  before = previous(); state.settings.scheduledCloseEnabled = true;
  assert.equal(rescheduleAfterSettings(state, before, now), false, "already on: no change");
  checks += 9;
}

console.log(`Close schedule golden tests passed (${checks} checks): WAT arithmetic, seed, manual and scheduled closes, catch-up, lateness, missed-close alert, overview and report views, settings changes.`);
