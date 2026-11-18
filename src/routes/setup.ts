import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context.ts';
import { createSession, SESSION_COOKIE, UserError } from '../auth/users.ts';
import { completeSetup } from '../setup/setup.ts';
import type { Market } from '../settings.ts';
import { MARKET_LABELS } from '../regions.ts';
import { html } from '../web/html.ts';
import { field, fields, go, page } from '../web/respond.ts';
import { sessionCookie } from './auth.ts';

function tokenOk(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function setupRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/setup', async (req, reply) => {
    const { site } = await ctx.settings.get();
    if (site.setupComplete) return go(reply, '/');
    const token = String((req.query as any).token ?? '');
    if (!tokenOk(ctx.cfg.setupToken, token)) {
      return page(
        ctx,
        req,
        reply,
        'Setup',
        html`<p>Enter the setup code. The installer shows it when it finishes, and it is in <code>data/setup-token</code>.</p>
        <form method="get" action="/setup">
          <label>Code <input name="token" required autocomplete="off"></label>
          <button>Continue</button>
        </form>`,
      );
    }
    const markets = (['US', 'EU', 'LATAM'] as Market[]).map(
      (m) => html`<label><input type="checkbox" name="markets" value="${m}" checked> ${MARKET_LABELS[m]}</label><br>`,
    );
    return page(
      ctx,
      req,
      reply,
      'Set up your platform',
      html`<form method="post" action="/setup">
        <input type="hidden" name="token" value="${token}">
        <fieldset><legend>1. Your site</legend>
          <label>Name <input name="siteName" required maxlength="60" value="My platform"></label><br>
          <label><input type="radio" name="mode" value="personal" checked> Personal: a single creator (you)</label><br>
          <label><input type="radio" name="mode" value="group"> Group: a studio or platform with several creators</label>
        </fieldset>
        <fieldset><legend>Content type</legend>
          <label><input type="radio" name="ageRestricted" value="0" required> General audience: viewers' ages do not need to be verified</label><br>
          <label><input type="radio" name="ageRestricted" value="1" required> Adults only (18+): age verification by region, 18+ notices and performer records (18 U.S.C. 2257)</label>
          <p><small>You can change this later in Admin → Site.</small></p>
        </fieldset>
        <fieldset><legend>2. Where you will operate</legend>
          ${markets}
          <p><small>We enable the payment and verification providers for those markets in test mode. Afterwards you only need to add your credentials.</small></p>
        </fieldset>
        <fieldset><legend>3. Admin account</legend>
          <label>Email <input type="email" name="email" required></label><br>
          <label>Public name <input name="displayName" required minlength="3" maxlength="24"></label><br>
          <label>Password <input type="password" name="password" required minlength="8"></label><br>
          <label><input type="checkbox" name="adminIsCreator" value="1" checked> I will also broadcast (always in personal mode)</label>
        </fieldset>
        <button>Finish setup</button>
      </form>`,
    );
  });

  app.post('/setup', async (req, reply) => {
    const b = req.body;
    if (!tokenOk(ctx.cfg.setupToken, field(b, 'token'))) return go(reply, '/setup', 'err', 'Incorrect setup code.');
    if (!['0', '1'].includes(field(b, 'ageRestricted'))) {
      return go(reply, `/setup?token=${encodeURIComponent(field(b, 'token'))}`, 'err', 'Choose the content type.');
    }
    try {
      const user = await completeSetup(ctx, {
        siteName: field(b, 'siteName'),
        mode: field(b, 'mode') as 'personal' | 'group',
        markets: fields(b, 'markets') as Market[],
        email: field(b, 'email'),
        displayName: field(b, 'displayName'),
        password: field(b, 'password'),
        adminIsCreator: field(b, 'adminIsCreator') === '1',
        ageRestricted: field(b, 'ageRestricted') === '1',
      });
      const token = await createSession(ctx.db, user.id);
      reply.setCookie(SESSION_COOKIE, token, sessionCookie(ctx));
      return go(reply, '/admin', 'ok', 'Setup complete. Review the list of pending steps.');
    } catch (err) {
      if (err instanceof UserError) return go(reply, `/setup?token=${encodeURIComponent(field(b, 'token'))}`, 'err', err.message);
      throw err;
    }
  });
}
