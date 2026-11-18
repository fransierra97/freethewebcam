import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx } from '../context.ts';
import { html, type Raw } from './html.ts';

export const LEGAL_PAGES = [
  { slug: 'terms', title: 'Terms of use' },
  { slug: 'privacy', title: 'Privacy' },
  { slug: 'cookies', title: 'Cookies' },
  { slug: 'rules', title: 'Community rules' },
  { slug: 'takedown', title: 'Reports and content takedown' },
] as const;

export function legalTemplate(slug: string): string {
  return readFileSync(join(import.meta.dirname, '..', '..', 'config', 'legal', `${slug}.md`), 'utf8');
}

export async function legalSource(ctx: Ctx, slug: string): Promise<string> {
  const row = await ctx.db.one<{ body: string }>('select body from legal_pages where slug = $1', [slug]);
  return row?.body ?? legalTemplate(slug);
}

/** Replaces {{site}}, {{operator}}, {{address}} and {{email}} with the operator's details. */
export async function fillPlaceholders(ctx: Ctx, text: string): Promise<string> {
  const { site, compliance: c } = await ctx.settings.get();
  const values: Record<string, string> = {
    site: site.name,
    operator: c.operatorName || '[operator name not configured]',
    address: c.operatorAddress || '[address not configured]',
    email: c.contactEmail || '[contact email not configured]',
  };
  return text.replace(/\{\{(\w+)\}\}/g, (m, k) => values[k] ?? m);
}

/**
 * Minimal, safe format (everything is escaped): “# heading”, “- item”, “> note”
 * and paragraphs separated by blank lines.
 */
export function renderLegal(text: string): Raw {
  const blocks = text.replace(/\r/g, '').split(/\n\s*\n/);
  const out: Raw[] = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim());
    if (!lines.length) continue;
    if (lines.every((l) => l.startsWith('- '))) {
      out.push(html`<ul>${lines.map((l) => html`<li>${l.slice(2)}</li>`)}</ul>`);
    } else if (lines.length === 1 && lines[0].startsWith('# ')) {
      out.push(html`<h2>${lines[0].slice(2)}</h2>`);
    } else if (lines.every((l) => l.startsWith('> '))) {
      out.push(html`<p><em>${lines.map((l) => l.slice(2)).join(' ')}</em></p>`);
    } else {
      out.push(html`<p>${lines.join(' ')}</p>`);
    }
  }
  return html`${out}`;
}
