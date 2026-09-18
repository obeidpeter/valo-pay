/** Supported message tokens shared by previews and approval validation. */
export const templatePlaceholders = ['amount', 'date', 'merchant', 'contact'] as const;

/** Every message includes these four values; unmatched braces and unknown tokens are refused. */
export function templateTextProblems(value: unknown): string[] {
  const text = typeof value === 'string' ? value : '';
  const found = new Set<string>();
  const problems: string[] = [];
  const remainder = text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_token, name: string) => {
    const field = name.trim();
    found.add(field);
    if (!(templatePlaceholders as readonly string[]).includes(field)) problems.push(`Unknown placeholder {{${field}}. Use only {{amount}}, {{date}}, {{merchant}} and {{contact}}.`);
    return '';
  });
  if (/[{}]/.test(remainder)) problems.push('A placeholder has unmatched or malformed braces. Use two braces on each side, for example {{amount}}.');
  for (const field of templatePlaceholders) if (!found.has(field)) problems.push(`Template text must include {{${field}}}.`);
  return [...new Set(problems)];
}
