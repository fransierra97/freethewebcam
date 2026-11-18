import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Ctx } from '../context.ts';
import { needAdmin, needCreator, needUser } from '../web/guards.ts';
import { viewerAccess } from '../access.ts';
import { audit, UserError } from '../auth/users.ts';
import { verifiedPerformers } from '../compliance/records.ts';
import {
  addItem,
  albumItems,
  canView,
  createAlbum,
  deleteItem,
  getAlbum,
  reviewAlbum,
  setCover,
  setPerformers,
  STATUS_LABEL,
  submitForReview,
  unlockAlbum,
  updateAlbum,
  type Album,
  type AlbumItem,
} from '../content/albums.ts';
import { LIMITS, readRange } from '../content/store.ts';
import { html, type Raw } from '../web/html.ts';
import { field, fields, go, intField, page } from '../web/respond.ts';

const studioNav = html`<nav class="tabs" aria-label="Studio">
  <a href="/studio">Overview</a><a href="/studio/live">Go live</a><a href="/studio/settings">Settings</a>
  <a href="/studio/albums">Albums</a><a href="/studio/earnings">Earnings</a></nav>`;

function coverMedia(album: Pick<Album, 'id' | 'cover_file'>, hue = 320): Raw {
  return album.cover_file
    ? html`<img src="/content/cover/${album.id}" alt="" loading="lazy">`
    : html`<span class="card-initial" style="--hue:${hue}">▣</span>`;
}

/** Sends an encrypted file, decrypting it on the fly, with Range support for videos. */
async function sendEncrypted(ctx: Ctx, req: FastifyRequest, reply: FastifyReply, file: string, iv: string, mime: string, size: number) {
  reply.header('accept-ranges', 'bytes').header('cache-control', 'private, no-store').header('content-disposition', 'inline').type(mime);
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    end = Math.min(end, size - 1);
    if (start > end || start >= size) return reply.code(416).header('content-range', `bytes */${size}`).send();
    reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`).header('content-length', end - start + 1);
    return reply.send(readRange(ctx, file, iv, start, end));
  }
  reply.header('content-length', size);
  return reply.send(readRange(ctx, file, iv, 0, size - 1));
}

export async function albumRoutes(app: FastifyInstance, ctx: Ctx) {
  // ---- Studio ----
  app.get('/studio/albums', async (req, reply) => {
    if (!needCreator(req, reply)) return;
    const rows = await ctx.db.query<Album & { items: number; unlocks: number }>(
      `select a.*, (select count(*)::int from album_items i where i.album_id = a.id) as items,
         (select count(*)::int from album_unlocks u where u.album_id = a.id) as unlocks
       from albums a where a.creator_id = $1 and a.status <> 'removed' order by a.id desc`,
      [req.user.id],
    );
    return page(
      ctx,
      req,
      reply,
      'Albums',
      html`${studioNav}
      <p>Upload photos and videos in albums. Your fans unlock them with tokens. Every album is reviewed before it is published.</p>
      <form method="post" action="/studio/albums" class="inline-form">
        <label>Title <input name="title" maxlength="120" required></label>
        <label>Price (tokens) <input type="number" name="price" min="1" max="100000" value="100" required></label>
        <button class="primary">Create album</button>
      </form>
      ${rows.length
        ? html`<ul class="cards">${rows.map(
            (a) => html`<li class="card"><a href="/studio/albums/${a.id}">
              <div class="card-media album-media">${coverMedia(a)}<span class="badge">${STATUS_LABEL[a.status]}</span></div>
              <div class="card-body"><div class="card-title"><span>${a.title}</span><small>${a.price} tk</small></div>
              <div class="card-sub">${a.items} items · ${a.unlocks} unlocks</div></div></a></li>`,
          )}</ul>`
        : html`<div class="empty">You have no albums yet.</div>`}`,
    );
  });

  app.post('/studio/albums', async (req, reply) => {
    if (!needCreator(req, reply)) return;
    const id = await createAlbum(ctx, req.user, field(req.body, 'title'), intField(req.body, 'price'), '');
    return go(reply, `/studio/albums/${id}`, 'ok', 'Album created. Upload photos and videos.');
  });

  const ownAlbum = async (req: FastifyRequest): Promise<Album> => {
    const album = await getAlbum(ctx.db, Number((req.params as any).id));
    if (!album || album.creator_id !== req.user!.id) throw new UserError('Album not found.');
    return album;
  };

  app.get('/studio/albums/:id', async (req, reply) => {
    if (!needCreator(req, reply)) return;
    const album = await ownAlbum(req);
    const items = await albumItems(ctx.db, album.id);
    const performers = await verifiedPerformers(ctx.db, req.user.id);
    const chosen = new Set(
      (await ctx.db.query<{ record_id: number }>('select record_id from album_performers where album_id = $1', [album.id])).map((r) => r.record_id),
    );
    const editableNow = album.status !== 'removed' && album.status !== 'pending_review';
    return page(
      ctx,
      req,
      reply,
      album.title,
      html`${studioNav}
      <p><span class="pill">${STATUS_LABEL[album.status]}</span> ${album.review_note ? html`<small>${album.review_note}</small>` : ''}</p>
      ${album.status === 'published' ? html`<p><small>If you change anything, the album goes back to review and is hidden until it is approved.</small></p>` : ''}
      <div class="album-editor">
        <section class="panel">
          <h2>Details</h2>
          <form method="post" action="/studio/albums/${album.id}">
            <label>Title <input name="title" maxlength="120" value="${album.title}" required></label>
            <label>Price (tokens) <input type="number" name="price" min="1" max="100000" value="${album.price}" required></label><br>
            <label>Description <textarea name="description" maxlength="2000">${album.description}</textarea></label><br>
            <button ${editableNow ? '' : 'disabled'}>Save</button>
          </form>
          <h2>Public cover</h2>
          <p><small>Anyone who has not unlocked the album sees it: use an image suitable for all audiences.</small></p>
          <div class="cover-preview">${coverMedia(album)}</div>
          <form method="post" action="/studio/albums/${album.id}/cover" enctype="multipart/form-data">
            <input type="file" name="file" accept="image/jpeg,image/png,image/webp" required> <button ${editableNow ? '' : 'disabled'}>Upload cover</button>
          </form>
          <h2>Who appears</h2>
          <form method="post" action="/studio/albums/${album.id}/performers">
            ${performers.map(
              (r) => html`<label><input type="checkbox" name="performer" value="${r.id}" ${chosen.has(r.id) || r.kind === 'primary' ? 'checked' : ''} ${r.kind === 'primary' ? 'disabled' : ''}> ${r.stage_name}${r.kind === 'primary' ? ' (you)' : ''}</label><br>`,
            )}
            <p><small>Only people with a verified record. <a href="/studio/records">Manage</a></small></p>
            <button ${editableNow ? '' : 'disabled'}>Save</button>
          </form>
        </section>
        <section class="panel">
          <h2>Photos and videos (${items.length}/${LIMITS.itemsPerAlbum})</h2>
          <form method="post" action="/studio/albums/${album.id}/upload" enctype="multipart/form-data">
            <input type="file" name="files" multiple accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime" required>
            <button class="primary" ${editableNow ? '' : 'disabled'}>Upload</button>
            <p><small>Photos up to 25 MB (JPG, PNG, WEBP, GIF). Videos up to 2 GB (MP4, WEBM, MOV). Everything is stored encrypted.</small></p>
          </form>
          <ul class="media-grid">${items.map(
            (i) => html`<li>${i.kind === 'image'
              ? html`<img src="/content/item/${i.id}" alt="" loading="lazy">`
              : html`<video src="/content/item/${i.id}" preload="metadata" muted></video>`}
              <form method="post" action="/studio/albums/${album.id}/items/${i.id}/delete"><button class="linklike" ${editableNow ? '' : 'disabled'}>Remove</button></form></li>`,
          )}</ul>
          <form method="post" action="/studio/albums/${album.id}/submit">
            <button class="primary" ${['draft', 'rejected'].includes(album.status) ? '' : 'disabled'}>Submit for review</button>
          </form>
        </section>
      </div>`,
    );
  });

  app.post('/studio/albums/:id', async (req, reply) => {
    if (!needCreator(req, reply)) return;
    const album = await ownAlbum(req);
    await updateAlbum(ctx, album, req.user, { title: field(req.body, 'title'), price: intField(req.body, 'price'), description: field(req.body, 'description') });
    return go(reply, `/studio/albums/${album.id}`, 'ok', 'Saved.');
  });

  app.post('/studio/albums/:id/performers', async (req, reply) => {
    if (!needCreator(req, reply)) return;
    const album = await ownAlbum(req);
    await setPerformers(ctx, album, req.user, fields(req.body, 'performer').map(Number));
    return go(reply, `/studio/albums/${album.id}`, 'ok', 'Saved.');
  });

  app.post('/studio/albums/:id/cover', async (req, reply) => {
    if (!needCreator(req, reply)) return;
    const album = await ownAlbum(req);
    const part = await req.file({ limits: { fileSize: LIMITS.image, files: 1 } });
    if (!part) throw new UserError('Choose an image.');
    await setCover(ctx, album, req.user, part.file, part.mimetype);
    return go(reply, `/studio/albums/${album.id}`, 'ok', 'Cover updated.');
  });

  app.post('/studio/albums/:id/upload', async (req, reply) => {
    if (!needCreator(req, reply)) return;
    const album = await ownAlbum(req);
    let added = 0;
    const errors: string[] = [];
    for await (const part of req.files({ limits: { fileSize: LIMITS.video, files: 20 } })) {
      try {
        await addItem(ctx, album, req.user, part.file, part.mimetype);
        added++;
      } catch (err) {
        part.file.resume();
        errors.push(`${part.filename}: ${(err as Error).message}`);
      }
    }
    if (errors.length) return go(reply, `/studio/albums/${album.id}`, 'err', `${added} uploaded. Errors: ${errors.join(' · ')}`.slice(0, 600));
    return go(reply, `/studio/albums/${album.id}`, 'ok', `${added} items uploaded.`);
  });

  app.post('/studio/albums/:id/items/:itemId/delete', async (req, reply) => {
    if (!needCreator(req, reply)) return;
    const album = await ownAlbum(req);
    await deleteItem(ctx, album, req.user, Number((req.params as any).itemId));
    return go(reply, `/studio/albums/${album.id}`, 'ok', 'Removed.');
  });

  app.post('/studio/albums/:id/submit', async (req, reply) => {
    if (!needCreator(req, reply)) return;
    const album = await ownAlbum(req);
    await submitForReview(ctx, album, req.user);
    return go(reply, `/studio/albums/${album.id}`, 'ok', 'Submitted for review.');
  });

  // ---- Fans ----
  app.get('/albums/:id', async (req, reply) => {
    if (!needUser(req, reply)) return;
    if (!(await viewerAccess(ctx, req.user, req.country)).ok) return go(reply, `/age-check?next=/albums/${(req.params as any).id}`);
    const album = await getAlbum(ctx.db, Number((req.params as any).id));
    if (!album) return reply.code(404).send('Not found');
    const owner = await ctx.db.one<{ display_name: string; slug: string }>(
      'select u.display_name, p.slug from users u join creator_profiles p on p.user_id = u.id where u.id = $1',
      [album.creator_id],
    );
    const full = await canView(ctx.db, album, req.user);
    if (!full && album.status !== 'published') return reply.code(404).send('Not found');
    const items = await albumItems(ctx.db, album.id);
    const photos = items.filter((i) => i.kind === 'image').length;
    const videos = items.length - photos;
    return page(
      ctx,
      req,
      reply,
      album.title,
      html`<p><a href="/c/${owner?.slug}">← ${owner?.display_name}</a></p>
      <div class="section-head"><h1>${album.title}</h1><span class="pill">${photos} photos · ${videos} videos</span></div>
      ${album.description ? html`<p class="lead">${album.description}</p>` : ''}
      ${full
        ? html`<ul class="media-grid viewer" data-watermark="@${req.user.display_name}">${items.map(
            (i: AlbumItem) => html`<li>${i.kind === 'image'
              ? html`<a href="/content/item/${i.id}" target="_blank"><img src="/content/item/${i.id}" alt="" loading="lazy"></a>`
              : html`<video src="/content/item/${i.id}" controls preload="metadata" controlslist="nodownload"></video>`}
              <span class="watermark">@${req.user.display_name}</span></li>`,
          )}</ul>
          <p><small>Content for your personal use. Every copy carries your name: sharing it breaks the terms and may lead to your account being closed.</small></p>`
        : html`<div class="locked">
            <div class="card-media album-media">${coverMedia(album)}</div>
            <div class="panel">
              <h2>Unlock the album</h2>
              <p>${photos} photos and ${videos} videos, yours forever for <strong class="price">${album.price} tokens</strong>.</p>
              <form method="post" action="/albums/${album.id}/unlock"><button class="primary">Unlock for ${album.price} tokens</button></form>
            </div>
          </div>`}`,
      { hideTitle: true },
    );
  });

  app.post('/albums/:id/unlock', async (req, reply) => {
    if (!needUser(req, reply)) return;
    if (!(await viewerAccess(ctx, req.user, req.country)).ok) throw new UserError('You need to verify your age.');
    const id = Number((req.params as any).id);
    await unlockAlbum(ctx, req.user, id);
    return go(reply, `/albums/${id}`, 'ok', 'Album unlocked!');
  });

  // ---- Files (always served through the app, never public) ----
  app.get('/content/item/:id', async (req, reply) => {
    if (!needUser(req, reply)) return;
    const item = await ctx.db.one<AlbumItem>('select * from album_items where id = $1', [Number((req.params as any).id)]);
    const album = item ? await getAlbum(ctx.db, item.album_id) : undefined;
    if (!item || !album || !(await canView(ctx.db, album, req.user))) return reply.code(404).send('Not found');
    const isOwnerOrAdmin = album.creator_id === req.user.id || req.user.is_admin;
    if (!isOwnerOrAdmin && !(await viewerAccess(ctx, req.user, req.country)).ok) return reply.code(403).send('Verify your age');
    if (req.user.is_admin && album.creator_id !== req.user.id) await audit(ctx.db, req.user.id, 'album.view_item', { itemId: item.id });
    return sendEncrypted(ctx, req, reply, item.file, item.iv, item.mime, Number(item.bytes));
  });

  app.get('/content/cover/:albumId', async (req, reply) => {
    if (!needUser(req, reply)) return;
    const album = await getAlbum(ctx.db, Number((req.params as any).albumId));
    if (!album?.cover_file || !album.cover_iv || !album.cover_mime) return reply.code(404).send('Not found');
    const isOwnerOrAdmin = album.creator_id === req.user.id || req.user.is_admin;
    if (!isOwnerOrAdmin && (album.status !== 'published' || !(await viewerAccess(ctx, req.user, req.country)).ok)) return reply.code(404).send('Not found');
    const { statSync } = await import('node:fs');
    const { contentDir } = await import('../content/store.ts');
    const size = statSync(`${contentDir(ctx)}/${album.cover_file}`).size;
    return sendEncrypted(ctx, req, reply, album.cover_file, album.cover_iv, album.cover_mime, size);
  });

  // ---- Admin ----
  app.get('/admin/albums', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const rows = await ctx.db.query<Album & { owner: string; items: number }>(
      `select a.*, u.display_name as owner, (select count(*)::int from album_items i where i.album_id = a.id) as items
       from albums a join users u on u.id = a.creator_id where a.status <> 'draft'
       order by (a.status = 'pending_review') desc, a.id desc limit 200`,
    );
    return page(
      ctx,
      req,
      reply,
      'Albums',
      html`<p><a href="/admin">← Admin</a></p>
      ${rows.length
        ? html`<table><tr><th>#</th><th>Creator</th><th>Title</th><th>Items</th><th>Price</th><th>Status</th><th></th></tr>
          ${rows.map((a) => html`<tr><td>${a.id}</td><td>${a.owner}</td><td>${a.title}</td><td>${a.items}</td><td>${a.price}</td>
            <td>${a.status === 'pending_review' ? html`<strong>${STATUS_LABEL[a.status]}</strong>` : STATUS_LABEL[a.status]}</td><td><a href="/admin/albums/${a.id}">Review</a></td></tr>`)}</table>`
        : html`<div class="empty">No albums submitted.</div>`}`,
    );
  });

  app.get('/admin/albums/:id', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const album = await getAlbum(ctx.db, Number((req.params as any).id));
    if (!album) return reply.code(404).send('Not found');
    const items = await albumItems(ctx.db, album.id);
    const performers = await ctx.db.query<{ stage_name: string; status: string; id: number }>(
      'select r.id, r.stage_name, r.status from album_performers ap join performer_records r on r.id = ap.record_id where ap.album_id = $1',
      [album.id],
    );
    await audit(ctx.db, req.user.id, 'album.review_open', { albumId: album.id });
    return page(
      ctx,
      req,
      reply,
      `Review: ${album.title}`,
      html`<p><a href="/admin/albums">← Albums</a> · <span class="pill">${STATUS_LABEL[album.status]}</span></p>
      <h2>Who appears</h2>
      <ul>${performers.map((p) => html`<li><a href="/admin/records/${p.id}">${p.stage_name}</a> — ${p.status}</li>`)}</ul>
      <p><small>Check that everyone visible is on this list and matches their records. Videos are not analyzed by the automatic detector: review them in full.</small></p>
      <h2>Content</h2>
      <ul class="media-grid">${items.map(
        (i) => html`<li>${i.kind === 'image' ? html`<img src="/content/item/${i.id}" alt="">` : html`<video src="/content/item/${i.id}" controls preload="metadata"></video>`}
          <small>${i.kind === 'image' ? 'photo' : 'video'} · detector: ${i.scan_status}</small></li>`,
      )}</ul>
      ${album.status === 'pending_review'
        ? html`<form method="post" action="/admin/albums/${album.id}/review">
            <label>Note for the creator <input name="note" maxlength="500"></label>
            <button name="decision" value="approve" class="primary">Publish</button> <button name="decision" value="reject" class="danger">Reject</button>
          </form>`
        : ''}
      ${album.status === 'published'
        ? html`<form method="post" action="/admin/albums/${album.id}/remove"><button class="danger">Withdraw from sale</button></form>`
        : ''}`,
    );
  });

  app.post('/admin/albums/:id/review', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const id = Number((req.params as any).id);
    await reviewAlbum(ctx, id, req.user, field(req.body, 'decision') === 'approve', field(req.body, 'note'));
    return go(reply, `/admin/albums/${id}`, 'ok', 'Review saved.');
  });

  app.post('/admin/albums/:id/remove', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const id = Number((req.params as any).id);
    await ctx.db.query("update albums set status = 'removed' where id = $1", [id]);
    await audit(ctx.db, req.user.id, 'album.remove', { albumId: id });
    return go(reply, `/admin/albums/${id}`, 'ok', 'Withdrawn: no longer on sale. People who already bought it can still view it.');
  });
}
