import type { User } from '../auth/users.ts';
import { html, raw, type Raw } from './html.ts';

export interface PageInput {
  siteName: string;
  title: string;
  body: Raw;
  user?: User;
  balance?: number;
  ok?: string;
  err?: string;
  demo?: boolean;
  scripts?: string[];
  show2257?: boolean;
  /** Current path, used to mark the active menu link. */
  path?: string;
  /** Main brand color (#rrggbb). */
  brandColor?: string;
  /** The page renders its own title (home, rooms…). */
  hideTitle?: boolean;
  /** Extra class for the main container (e.g. “auth” for narrow forms). */
  mainClass?: string;
  unread?: { notifications: number; messages: number };
  ageRestricted?: boolean;
}

const HEX = /^#[0-9a-f]{6}$/i;

function navLink(path: string | undefined, href: string, label: Raw | string, extra = ''): Raw {
  const active = path === href || (href !== '/' && path?.startsWith(href + '/')) || (href !== '/' && path === href);
  return html`<a href="${href}" class="${extra}" ${active ? raw('aria-current="page"') : ''}>${label}</a>`;
}

export function renderPage(p: PageInput): string {
  const u = p.user;
  const nav = u
    ? html`${navLink(p.path, '/', 'Live')}
        ${navLink(p.path, '/following', 'Following')}
        ${u.creator_status !== 'none' ? navLink(p.path, '/studio', 'Studio') : navLink(p.path, '/become-creator', 'Become a creator')}
        ${u.is_admin ? navLink(p.path, '/admin', 'Admin') : ''}
        ${navLink(p.path, '/agenda', 'Schedule')}
        ${navLink(p.path, '/messages', html`Messages<span class="badge-count" id="unread-messages" ${p.unread?.messages ? '' : raw('hidden')}>${p.unread?.messages ?? 0}</span>`)}
        ${navLink(p.path, '/notifications', html`<span aria-label="Notifications">🔔</span><span class="badge-count" id="unread-notifications" ${p.unread?.notifications ? '' : raw('hidden')}>${p.unread?.notifications ?? 0}</span>`)}
        ${navLink(p.path, '/wallet', html`<strong id="balance">${p.balance ?? 0}</strong> tokens`, 'balance')}
        <span class="user-chip"><a href="/account" class="plain">${u.display_name}</a>
          <form method="post" action="/logout"><button class="linklike" title="Log out">Log out</button></form>
          <span class="avatar" aria-hidden="true">${u.display_name.slice(0, 1)}</span></span>`
    : html`${navLink(p.path, '/login', 'Log in')} ${navLink(p.path, '/register', 'Sign up', 'cta')}`;
  const scripts = [...(u ? ['/static/js/me.js'] : []), ...(p.scripts ?? [])].map((s) => html`<script type="module" src="${s}"></script>`);
  const brand = p.brandColor && HEX.test(p.brandColor) ? p.brandColor : '';
  // Mark the active tab in the studio and admin menus.
  let body = p.body.value;
  if (p.path && body.includes('class="tabs"')) {
    body = body.replace(`<a href="${p.path}">`, `<a href="${p.path}" aria-current="page">`);
  }
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${p.title} · ${p.siteName}</title>
<link rel="stylesheet" href="/static/theme.css">
${brand ? raw(`<style>:root{--brand:${brand}}</style>`) : ''}
</head>
<body>
${p.demo ? html`<div class="demo-banner">Demo mode: payments and verifications are simulated.</div>` : ''}
<header class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="/"><span class="brand-mark" aria-hidden="true"></span>${p.siteName}</a>
    <nav class="nav" aria-label="Main">${nav}</nav>
  </div>
</header>
${p.ok ? html`<p class="flash ok" role="status">${p.ok}</p>` : ''}
${p.err ? html`<p class="flash err" role="alert">${p.err}</p>` : ''}
<main class="container ${p.mainClass ?? ''}">
${p.hideTitle ? '' : html`<h1 class="page-title">${p.title}</h1>`}
${raw(body)}
</main>
<footer>
  <div class="footer-inner">
    ${p.ageRestricted ? html`<span class="age-notice">Adults only (18+)</span>` : ''}
    <a href="/legal/terms">Terms</a>
    <a href="/legal/privacy">Privacy</a>
    <a href="/legal/cookies">Cookies</a>
    <a href="/legal/rules">Community rules</a>
    <a href="/legal/takedown">Reports and takedown</a>
    ${p.show2257 ? html`<a href="/2257">18 U.S.C. 2257 Record-Keeping Requirements Compliance Statement</a>` : ''}
    <span>Powered by <a href="https://www.gnu.org/licenses/agpl-3.0.html">FreeTheWebcam (AGPL-3.0)</a></span>
  </div>
</footer>
${scripts}
</body>
</html>`.value;
}

export { raw };
