/** Retry policy guardrails (TRD 6.2), execution windows (DEB-01), quiet hours (NOT-04) and the Test 2 design (6.6). */

/** West Africa Time is UTC+1 all year. */
export const WAT_OFFSET_MS = 60 * 60 * 1000;

export const policyGuardrails = {
  /** Ceiling no policy may exceed, counting external attempts (RET-02). */
  maxAttemptsCeiling: 4,
  defaultMaxAttempts: 3,
  /** Floor for the minimum time between any two attempts, whatever the code. */
  minSpacingHours: 24,
  defaultSpacingHours: 48,
  minFirstNoticeHours: 24,
  defaultFirstNoticeHours: 48,
  /** The failed-debit notice carries the next attempt date; fixed floor, may be lengthened. */
  minRetryNoticeHours: 24,
  defaultRetryNoticeHours: 24,
} as const;

/** Debit execution window in WAT hours: default 06:00–10:00, configurable within 06:00–20:00. */
export const executionWindow = { earliestHour: 6, latestHour: 20, defaultStartHour: 6, defaultEndHour: 10 } as const;

/** Quiet hours for all customer messages, 21:00–08:00 WAT; the adapter refuses sends inside them. */
export const quietHours = { startHour: 21, endHour: 8 } as const;

export function watHourOf(epochMs: number): number {
  return new Date(epochMs + WAT_OFFSET_MS).getUTCHours();
}
export function withinQuietHours(epochMs: number): boolean {
  const hour = watHourOf(epochMs);
  return hour >= quietHours.startHour || hour < quietHours.endHour;
}
export function clampExecutionHour(value: unknown, fallback: number): number {
  const hour = Number(value);
  if (!Number.isInteger(hour)) return fallback;
  return Math.min(executionWindow.latestHour, Math.max(executionWindow.earliestHour, hour));
}

/** MAN-05 activation reminder caps by workflow type. */
export const activationReminderCaps = { transfer_to_activate: 4, hosted_consent: 2 } as const;
export const DEFAULT_ACTIVATION_WINDOW_DAYS = 7;

/** Section 6.6 experiment design and the pre-registered pass rule (RET-11). */
export const experimentRules = {
  minimumHoldoutShare: 0.1,
  maximumHoldoutShare: 0.5,
  /** Engine minus holdout recovery by value must exceed this. */
  effectPoints: 0.08,
  /** Two-sided 90% interval of the difference must exclude zero (one-sided 5%). */
  confidence: 0.9,
  /** Standard normal quantile for the two-sided 90% interval (one-sided 5%). */
  zScore: 1.6448536269514722,
  power: 0.8,
  outcomeWindowDays: 30,
  enrolmentCloseBeforeAnalysisDays: 30,
} as const;

export const passRuleText = "For each lender: engine minus holdout recovery rate by value ≥ 8 percentage points; the 90% confidence interval of the difference excludes zero; each arm has at least the pre-computed minimum sample. Any other result is 'not proven'.";

/** REC-09 and MEA-05 measurement rules: the monthly precision sample, its interval, the fortnightly review cadence and the Test 5 live-day floor. */
export const measurementRules = {
  precisionSampleSize: 200,
  precisionConfidence: 0.95,
  precisionZScore: 1.959963984540054,
  fortnightDays: 14,
  liveDaysRequired: 60,
  realCasesRequired: 5,
  jobsToConfirm: 4,
} as const;
