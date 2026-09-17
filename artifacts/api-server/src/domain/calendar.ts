import { WAT_OFFSET_MS } from "@workspace/valopay-schema";
import type { DomainState } from "./types";
import { recordsOf } from "./records";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Calendar date (YYYY-MM-DD) of an instant in West Africa Time. */
export function watDate(epochMs: number): string {
  return new Date(epochMs + WAT_OFFSET_MS).toISOString().slice(0, 10);
}

/** Nigerian public holidays and non-banking days are data (SCH-04), one calendar record per date. */
export function holidaySet(state: DomainState): Set<string> {
  return new Set(recordsOf(state, "calendar").map((record) => String(record.data.date)));
}

/** Monday to Friday in WAT, excluding the holiday table. */
export function isBusinessDay(epochMs: number, holidays: Set<string>): boolean {
  const wat = new Date(epochMs + WAT_OFFSET_MS);
  const weekday = wat.getUTCDay();
  return weekday !== 0 && weekday !== 6 && !holidays.has(wat.toISOString().slice(0, 10));
}

/** The same time of day, `days` business days after `fromIso`; used for exception deadlines (EXC-02). */
export function addBusinessDays(state: DomainState, fromIso: string, days: number): string {
  const holidays = holidaySet(state);
  let time = Date.parse(fromIso);
  let remaining = Math.max(0, Math.floor(days));
  while (remaining > 0) {
    time += DAY_MS;
    if (isBusinessDay(time, holidays)) remaining -= 1;
  }
  return new Date(time).toISOString();
}
