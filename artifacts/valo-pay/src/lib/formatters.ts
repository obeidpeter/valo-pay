export function formatKobo(kobo: number): string {
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    minimumFractionDigits: 2,
  }).format(kobo / 100);
}

export function formatDate(dateStr: string): string {
  if(!dateStr)return "Not recorded";
  const date=new Date(dateStr);
  if(!Number.isFinite(date.getTime()))return dateStr==="Not closed yet"?"Not closed yet":"Not recorded";
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Africa/Lagos',
  }).format(date);
}

export function formatCompactDate(dateStr: string): string {
  if(!dateStr||!Number.isFinite(new Date(dateStr).getTime()))return "Not recorded";
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Africa/Lagos'
  }).format(new Date(dateStr));
}
