/** HTML templates that escape everything by default. Use raw() only for trusted HTML. */

const RAW = Symbol('raw');
export interface Raw {
  [RAW]: true;
  value: string;
}

export function raw(value: string): Raw {
  return { [RAW]: true, value };
}

export function escape(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function render(value: unknown): string {
  if (value === null || value === undefined || value === false) return '';
  if (Array.isArray(value)) return value.map(render).join('');
  if (typeof value === 'object' && (value as Raw)[RAW]) return (value as Raw).value;
  return escape(value);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return raw(out);
}

export function money(cents: number, currency: string): string {
  return new Intl.NumberFormat('en', { style: 'currency', currency }).format(cents / 100);
}

export function date(value: Date | string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('en', { dateStyle: 'short', timeStyle: 'short' });
}
