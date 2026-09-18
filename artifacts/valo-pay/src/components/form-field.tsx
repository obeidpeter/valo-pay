import { type ReactNode } from 'react';

/**
 * What every form in the console shares when a value is missing or refused:
 * the message sits under the field it concerns, in the field's own words,
 * the control is marked invalid and described by the message, focus moves
 * to the first field that needs attention, and one alert at the top says
 * what happened so it is announced. Fields are checked before the server is
 * asked, and what the server refuses is placed under the field it names
 * (Nielsen 5: error prevention; 9: plain words, the problem stated
 * precisely, a way to fix it; universal design: perceptible, not colour
 * alone).
 */

export const fieldMessageId = (id: string): string => `${id}-error`;

/** Spread onto a control: marks it invalid and points assistive technology at its message. */
export function invalidProps(id: string, error?: string): { 'aria-invalid'?: true; 'aria-describedby'?: string } {
  return error ? { 'aria-invalid': true, 'aria-describedby': fieldMessageId(id) } : {};
}

/** The message under a field, when there is one. */
export function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return <p id={fieldMessageId(id)} className="text-sm text-destructive">{message}</p>;
}

/** The one alert a form shows: what happened, then anything that could not be placed under a field. */
export function FormAlert({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
      <p className="font-medium">{title}</p>
      {children}
    </div>
  );
}

/** Moves focus to a control by its id. */
export function focusField(id: string): void {
  document.getElementById(id)?.focus();
}

/** The words for a value that is missing, in the field's own label. */
export function missingMessage(label: string, type: string): string {
  return type === 'select' ? `Choose the ${label}.` : `Enter the ${label}.`;
}

/** How many fields need attention, as the alert's title when the server had nothing more specific to say. */
export function attentionTitle(count: number): string {
  return count === 1 ? 'One field needs attention before this can be saved.' : `${count} fields need attention before this can be saved.`;
}

type Detail = { field?: unknown; message?: unknown };

/**
 * Sorts what the server said into messages for the fields it names and the
 * rest. A validation failure whose every detail lands on a field needs no
 * general message; any other refusal (a rule, a role) is the title.
 */
export function serverFieldErrors(error: unknown, resolve: (path: string) => string | null): { fields: Record<string, string>; general: string[] } {
  const data = (error as { data?: { error?: unknown; details?: unknown } } | null)?.data;
  const said = typeof data?.error === 'string' ? data.error : (error as { message?: string } | null)?.message || 'This was not saved.';
  const details = Array.isArray(data?.details) ? (data.details as Detail[]) : [];
  const fields: Record<string, string> = {};
  const general: string[] = [];
  for (const detail of details) {
    const path = String(detail.field ?? ''), message = String(detail.message ?? 'This value was refused.');
    const name = resolve(path);
    if (name && !fields[name]) fields[name] = message;
    else general.push(path ? `${path}: ${message}` : message);
  }
  const validation = /^validation failed\.?$/i.test(said);
  if (!validation || general.length > 0 || details.length === 0) general.unshift(said);
  return { fields, general };
}
