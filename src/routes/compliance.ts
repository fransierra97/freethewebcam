import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Ctx } from '../context.ts';
import { needAdmin, needCreator, needUser } from '../web/guards.ts';
import { audit, UserError, type User } from '../auth/users.ts';
import {
  CONSENT_TEXT,
  claimInvite,
  ensurePrimaryRecord,
  exportIndex,
  getRecord,
  inviteCoPerformer,
  MAX_ID_COPY_BYTES,
  readIdCopy,
  readPii,
  reviewRecord,
  submitRecord,
  type PerformerPii,
  type PerformerRecord,
} from '../compliance/records.ts';
import { creatorById } from '../live/actions.ts';
import { date, html, type Raw } from '../web/html.ts';
import { field, go, page } from '../web/respond.ts';

const STATUS: Record<string, string> = {
  pending: 'Not submitted',
  submitted: 'Submitted, pending review',
  verified: 'Verified',
  rejected: 'Rejected',
  removed: 'Removed',
};

async function kycStatus(ctx: Ctx, userId: number | null): Promise<string> {
  if (!userId) return 'no account';
  const v = await ctx.db.one<{ status: string }>(
    "select status from verifications where user_id = $1 and purpose = 'creator_kyc' order by (status = 'approved') desc, id desc limit 1",
    [userId],
  );
  return v?.status ?? 'not started';
}

/** Reads a multipart form: text fields and at most one file. */
async function readMultipart(req: FastifyRequest) {
  const fields: Record<string, string> = {};
  let file: { data: Buffer; mimetype: string } | undefined;
  for await (const part of req.parts({ limits: { fileSize: MAX_ID_COPY_BYTES, files: 1 } })) {
    if (part.type === 'file') {
      const data = await part.toBuffer();
      if (data.length) file = { data, mimetype: part.mimetype };
    } else {
      fields[part.fieldname] = String(part.value ?? '');
    }
  }
  return { fields, file };
}

function recordForm(r: PerformerRecord, pii: PerformerPii | null, kyc: string): Raw {
  const editable = r.status !== 'verified' && r.status !== 'removed';
  const kycOk = kyc === 'approved';
  return html`<p>Record status: <strong>${STATUS[r.status]}</strong>${r.review_note ? html` — ${r.review_note}` : ''}</p>
    <p>Identity verification: <strong>${kycOk ? 'approved' : kyc}</strong></p>
    ${!kycOk
      ? html`<form method="post" action="/verify/start"><input type="hidden" name="purpose" value="creator_kyc">
          <button>Verify my identity</button></form>`
      : ''}
    ${editable
      ? html`<form method="post" action="/performer/record/${r.id}" enctype="multipart/form-data">
          <p><small>This information is stored encrypted and only the custodian of records can see it. The law (18 U.S.C. 2257) requires it from anyone who produces content with adult performers.</small></p>
          <label>Full legal name <input name="legalName" required value="${pii?.legalName ?? ''}"></label><br>
          <label>Date of birth <input type="date" name="dateOfBirth" required value="${pii?.dateOfBirth ?? ''}"></label><br>
          <label>Other names and aliases (comma-separated; include maiden and stage names) <input name="aliases" value="${(pii?.aliases ?? []).join(', ')}"></label><br>
          <label>Document type <select name="idType">
            ${['Passport', 'National ID card', 'Driver\'s license', 'Other official photo ID'].map(
              (t) => html`<option ${pii?.idType === t ? 'selected' : ''}>${t}</option>`,
            )}</select></label><br>
          <label>Document number <input name="idNumber" required value="${pii?.idNumber ?? ''}"></label><br>
          <label>Issuing country or state <input name="idIssuer" required value="${pii?.idIssuer ?? ''}"></label><br>
          <label>Expiry date <input type="date" name="idExpiry" required value="${pii?.idExpiry ?? ''}"></label><br>
          <label>Copy of the document (JPG, PNG, WEBP or PDF, max. 10 MB)${r.id_copy_file ? ' — one is already saved; upload another only to replace it' : ''}
            <input type="file" name="idCopy" accept="image/jpeg,image/png,image/webp,application/pdf" ${r.id_copy_file ? '' : 'required'}></label><br>
          <fieldset><legend>Declaration and consent</legend>
            <ul>${CONSENT_TEXT.map((t) => html`<li>${t}</li>`)}</ul>
            <label><input type="checkbox" name="consent" value="1" required> I agree</label>
          </fieldset>
          <button>Submit record</button>
        </form>`
      : html`<p>The record is closed. If anything changes (for example, the document), ask the admin to reopen it.</p>`}`;
}

export async function complianceRoutes(app: FastifyInstance, ctx: Ctx) {
  // ---- Public 2257 statement ----
  app.get('/2257', async (req, reply) => {
    const { compliance: c } = await ctx.settings.get();
    const configured = c.custodianName && c.custodianAddress;
    return page(
      ctx,
      req,
      reply,
      '18 U.S.C. 2257 Record-Keeping Requirements Compliance Statement',
      configured
        ? html`<p style="font-size:12pt">All models, actors, actresses and other persons who appear in any visual depiction of actual or simulated sexually explicit conduct appearing on or otherwise contained in this website were over the age of eighteen (18) years at the time of the creation of such depictions.</p>
          <p style="font-size:12pt">Records required to be maintained pursuant to 18 U.S.C. § 2257 and 28 C.F.R. Part 75 are kept by the custodian of records:</p>
          <address style="font-size:12pt">${c.custodianName}<br>${c.custodianTitle}<br>${c.operatorName ? html`${c.operatorName}<br>` : ''}${c.custodianAddress}</address>`
        : html`<p>The operator has not yet set up the custodian of records details.</p>`,
    );
  });

  // ---- Studio: my records and co-performers ----
  app.get('/studio/records', async (req, reply) => {
    if (!needCreator(req, reply)) return;
    const profile = await creatorById(ctx.db, req.user.id);
    const primary = await ensurePrimaryRecord(ctx.db, req.user, req.user.display_name);
    void profile;
    const co = await ctx.db.query<PerformerRecord>(
      "select * from performer_records where owner_id = $1 and kind = 'co_performer' and status <> 'removed' order by id desc",
      [req.user.id],
    );
    const coRows = [];
    for (const r of co) {
      coRows.push(html`<li>${r.stage_name} — ${STATUS[r.status]} · identity: ${await kycStatus(ctx, r.user_id)}
        ${r.user_id ? '' : ' · invitation not accepted'}
        <form method="post" action="/studio/records/${r.id}/remove" style="display:inline"><button>Remove</button></form></li>`);
    }
    const { compliance } = await ctx.settings.get();
    return page(
      ctx,
      req,
      reply,
      'Legal records',
      html`<p><a href="/studio">← Studio</a></p>
      ${compliance.require2257 ? html`<p><strong>To broadcast, your record and that of everyone who appears on camera must be verified.</strong></p>` : ''}
      <h2>Your record</h2>
      <p><a href="/performer/record/${primary.id}">${STATUS[primary.status]} — open</a></p>
      <h2>Co-performers</h2>
      <p>Everyone who appears on your camera needs their own account, must verify their identity and complete their record.</p>
      ${coRows.length ? html`<ul>${coRows}</ul>` : html`<p>None.</p>`}
      <form method="post" action="/studio/records/invite">
        <label>Stage name <input name="stageName" required maxlength="60"></label>
        <button>Create invitation</button>
      </form>`,
    );
  });

  app.post('/studio/records/invite', async (req, reply) => {
    if (!needCreator(req, reply)) return;
    const link = await inviteCoPerformer(ctx, req.user, field(req.body, 'stageName'));
    return page(
      ctx,
      req,
      reply,
      'Invitation created',
      html`<p>Send this link to the person. It can be used once and is only shown now:</p>
      <p><code>${link}</code></p>
      <p>They will need to create an account (or sign in), verify their identity and complete their record. The admin will then review it.</p>
      <p><a href="/studio/records">Back</a></p>`,
    );
  });

  app.post('/studio/records/:id/remove', async (req, reply) => {
    if (!needCreator(req, reply)) return;
    const r = await getRecord(ctx.db, Number((req.params as any).id));
    if (!r || r.owner_id !== req.user.id || r.kind !== 'co_performer') throw new UserError('Record not found.');
    // Not deleted: the law requires keeping it. The person just can no longer appear on camera.
    await ctx.db.query("update performer_records set status = 'removed', invite_token_hash = null, updated_at = now() where id = $1", [r.id]);
    await audit(ctx.db, req.user.id, 'record.remove', { recordId: r.id });
    return go(reply, '/studio/records', 'ok', 'Removed. The record is kept as required by law.');
  });

  // ---- Performer (creator or co-performer) ----
  app.get('/performer/invite/:token', async (req, reply) => {
    if (!needUser(req, reply)) return;
    const r = await claimInvite(ctx, (req.params as any).token, req.user);
    return go(reply, `/performer/record/${r.id}`, 'ok', 'Invitation accepted. Complete your record.');
  });

  app.get('/performer', async (req, reply) => {
    if (!needUser(req, reply)) return;
    const rows = await ctx.db.query<PerformerRecord & { owner: string }>(
      `select r.*, u.display_name as owner from performer_records r join users u on u.id = r.owner_id
       where r.user_id = $1 and r.status <> 'removed' order by r.id`,
      [req.user.id],
    );
    return page(
      ctx,
      req,
      reply,
      'My performer records',
      rows.length
        ? html`<ul>${rows.map((r) => html`<li><a href="/performer/record/${r.id}">${r.owner}'s room as “${r.stage_name}”</a> — ${STATUS[r.status]}</li>`)}</ul>`
        : html`<p>You have no records.</p>`,
    );
  });

  const canSee = (r: PerformerRecord, u: User) => r.user_id === u.id;

  app.get('/performer/record/:id', async (req, reply) => {
    if (!needUser(req, reply)) return;
    const r = await getRecord(ctx.db, Number((req.params as any).id));
    if (!r || !canSee(r, req.user)) return reply.code(404).send('Not found');
    return page(
      ctx,
      req,
      reply,
      `Performer record: ${r.stage_name}`,
      recordForm(r, readPii(ctx, r), await kycStatus(ctx, r.user_id)),
    );
  });

  app.post('/performer/record/:id', async (req, reply) => {
    if (!needUser(req, reply)) return;
    const r = await getRecord(ctx.db, Number((req.params as any).id));
    if (!r || !canSee(r, req.user)) return reply.code(404).send('Not found');
    const { fields: f, file } = await readMultipart(req);
    await submitRecord(ctx, r, req.user, {
      pii: {
        legalName: (f.legalName ?? '').trim(),
        dateOfBirth: f.dateOfBirth ?? '',
        aliases: (f.aliases ?? '').split(','),
        idType: f.idType ?? '',
        idNumber: (f.idNumber ?? '').trim(),
        idIssuer: (f.idIssuer ?? '').trim(),
        idExpiry: f.idExpiry ?? '',
      },
      idCopy: file,
      consent: f.consent === '1',
    });
    return go(reply, `/performer/record/${r.id}`, 'ok', 'Record submitted. The admin will review it.');
  });

  // ---- Admin ----
  app.get('/admin/records', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const rows = await ctx.db.query<PerformerRecord & { owner: string }>(
      `select r.*, u.display_name as owner from performer_records r join users u on u.id = r.owner_id
       order by (r.status = 'submitted') desc, r.updated_at desc limit 300`,
    );
    const out = [];
    for (const r of rows) {
      out.push(html`<tr><td>R-${r.id}</td><td>${r.stage_name}</td><td>${r.kind === 'primary' ? 'creator' : 'co-performer'}</td><td>${r.owner}</td>
        <td>${STATUS[r.status]}</td><td>${await kycStatus(ctx, r.user_id)}</td><td>${date(r.updated_at)}</td>
        <td><a href="/admin/records/${r.id}">Review</a></td></tr>`);
    }
    return page(
      ctx,
      req,
      reply,
      'Performer records (2257)',
      html`<p><a href="/admin">← Admin</a> · <a href="/admin/records/export.csv">Download index for the custodian (CSV)</a> · <a href="/admin/compliance">Operator and custodian details</a></p>
      <p><small>They are kept for at least 7 years after the last modification (28 CFR 75.4). The application never deletes them.</small></p>
      ${out.length
        ? html`<table><tr><th>Record</th><th>Stage name</th><th>Type</th><th>Room</th><th>Status</th><th>Identity</th><th>Updated</th><th></th></tr>${out}</table>`
        : html`<p>None yet.</p>`}`,
    );
  });

  app.get('/admin/records/export.csv', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    await audit(ctx.db, req.user.id, 'record.export');
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="index-2257-${new Date().toISOString().slice(0, 10)}.csv"`)
      .header('cache-control', 'no-store')
      .send(await exportIndex(ctx));
  });

  app.get('/admin/records/:id', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const r = await getRecord(ctx.db, Number((req.params as any).id));
    if (!r) return reply.code(404).send('Not found');
    await audit(ctx.db, req.user.id, 'record.view', { recordId: r.id });
    const pii = readPii(ctx, r);
    const sessions = await ctx.db.query(
      `select s.id, s.title, s.started_at, s.ended_at from broadcast_performers bp join broadcast_sessions s on s.id = bp.session_id
       where bp.record_id = $1 order by s.started_at desc limit 100`,
      [r.id],
    );
    return page(
      ctx,
      req,
      reply,
      `Record R-${r.id}: ${r.stage_name}`,
      html`<p><a href="/admin/records">← Records</a></p>
      <ul>
        <li>Status: <strong>${STATUS[r.status]}</strong> ${r.review_note ? html`(${r.review_note})` : ''}</li>
        <li>Provider identity verification: <strong>${await kycStatus(ctx, r.user_id)}</strong></li>
        <li>Consent: ${r.consent_signed_at ? html`version ${r.consent_version}, ${date(r.consent_signed_at)}` : 'not signed'}</li>
      </ul>
      ${pii
        ? html`<h2>Details</h2><ul>
            <li>Legal name: ${pii.legalName}</li><li>Date of birth: ${pii.dateOfBirth}</li>
            <li>Aliases: ${pii.aliases.join(', ')}</li>
            <li>Document: ${pii.idType} ${pii.idNumber} (${pii.idIssuer}, expires ${pii.idExpiry})</li></ul>
            ${r.id_copy_file ? html`<p><a href="/admin/records/${r.id}/id-copy" target="_blank" rel="noopener">View copy of the document</a> (this is logged)</p>` : ''}`
        : html`<p>They have not submitted their details yet.</p>`}
      ${r.status === 'submitted'
        ? html`<h2>Review</h2>
          <p>Check that the name, date of birth and photo on the document match the identity verification and the person on camera.</p>
          <form method="post" action="/admin/records/${r.id}/review">
            <label>Note <input name="note" maxlength="500"></label>
            <button name="decision" value="approve">Verify</button> <button name="decision" value="reject">Reject</button>
          </form>`
        : ''}
      ${r.status === 'verified' || r.status === 'rejected'
        ? html`<form method="post" action="/admin/records/${r.id}/reopen"><button>Reopen for corrections</button></form>`
        : ''}
      <h2>Broadcasts they appear in</h2>
      ${sessions.length
        ? html`<ul>${sessions.map((s: any) => html`<li>#${s.id} · ${date(s.started_at)} – ${date(s.ended_at)} · ${s.title}</li>`)}</ul>`
        : html`<p>None.</p>`}`,
    );
  });

  app.get('/admin/records/:id/id-copy', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const r = await getRecord(ctx.db, Number((req.params as any).id));
    const copy = r ? readIdCopy(ctx, r) : null;
    if (!r || !copy) return reply.code(404).send('Not found');
    await audit(ctx.db, req.user.id, 'record.view_id_copy', { recordId: r.id });
    return reply.type(copy.type).header('cache-control', 'no-store').header('content-disposition', 'inline').send(copy.data);
  });

  app.post('/admin/records/:id/review', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const id = Number((req.params as any).id);
    await reviewRecord(ctx, id, req.user, field(req.body, 'decision') === 'approve', field(req.body, 'note'));
    return go(reply, `/admin/records/${id}`, 'ok', 'Review saved.');
  });

  app.post('/admin/records/:id/reopen', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const id = Number((req.params as any).id);
    await ctx.db.query("update performer_records set status = 'pending', updated_at = now() where id = $1", [id]);
    await audit(ctx.db, req.user.id, 'record.reopen', { recordId: id });
    return go(reply, `/admin/records/${id}`, 'ok', 'Reopened: the person can correct their details.');
  });

  app.get('/admin/compliance', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const { compliance: c } = await ctx.settings.get();
    return page(
      ctx,
      req,
      reply,
      'Operator, custodian and moderation',
      html`<p><a href="/admin">← Admin</a></p>
      <form method="post" action="/admin/compliance">
        <fieldset><legend>Operator (shown in the legal pages)</legend>
          <label>Name or company name <input name="operatorName" value="${c.operatorName}"></label><br>
          <label>Address <input name="operatorAddress" value="${c.operatorAddress}" size="60"></label><br>
          <label>Legal contact email <input type="email" name="contactEmail" value="${c.contactEmail}"></label>
        </fieldset>
        <fieldset><legend>Custodian of records (18 U.S.C. 2257)</legend>
          <label><input type="checkbox" name="require2257" value="1" ${c.require2257 ? 'checked' : ''}> Require verified records before broadcasting</label><br>
          <label>Custodian name <input name="custodianName" value="${c.custodianName}"></label><br>
          <label>Title <input name="custodianTitle" value="${c.custodianTitle}"></label><br>
          <label>Street address where the records are kept (a P.O. box is not valid) <input name="custodianAddress" value="${c.custodianAddress}" size="60"></label>
        </fieldset>
        <fieldset><legend>Live moderation</legend>
          <label>Seconds between check frames (0 = disabled) <input type="number" name="frameIntervalSeconds" min="0" max="3600" value="${c.frameIntervalSeconds}"></label><br>
          <label>Days to keep frames with no incidents <input type="number" name="frameRetentionDays" min="1" max="90" value="${c.frameRetentionDays}"></label>
        </fieldset>
        <button>Save</button>
      </form>`,
    );
  });

  app.post('/admin/compliance', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const b = req.body;
    const { compliance: before } = await ctx.settings.get();
    const num = (k: string, min: number, max: number) => {
      const n = Number(field(b, k));
      if (!Number.isInteger(n) || n < min || n > max) throw new UserError(`Invalid value: ${k}`);
      return n;
    };
    const require2257 = field(b, 'require2257') === '1';
    if (before.require2257 && !require2257) {
      await audit(ctx.db, req.user.id, 'compliance.disable_2257');
    }
    const custodianAddress = field(b, 'custodianAddress').trim();
    if (/\b(p\.?\s?o\.?\s?box|apartado de correos)\b/i.test(custodianAddress)) throw new UserError('The custodian address cannot be a P.O. box.');
    await ctx.settings.set('compliance', {
      require2257,
      operatorName: field(b, 'operatorName').trim().slice(0, 200),
      operatorAddress: field(b, 'operatorAddress').trim().slice(0, 300),
      contactEmail: field(b, 'contactEmail').trim().slice(0, 200),
      custodianName: field(b, 'custodianName').trim().slice(0, 200),
      custodianTitle: field(b, 'custodianTitle').trim().slice(0, 200),
      custodianAddress: custodianAddress.slice(0, 300),
      frameIntervalSeconds: num('frameIntervalSeconds', 0, 3600),
      frameRetentionDays: num('frameRetentionDays', 1, 90),
    });
    await audit(ctx.db, req.user.id, 'compliance.update');
    return go(reply, '/admin/compliance', 'ok', 'Saved.');
  });
}
