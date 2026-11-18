/** Direct messages between fans and creators. The creator can charge for each message received. */
import type { Ctx } from '../context.ts';
import { UserError, type User } from '../auth/users.ts';
import { InsufficientFunds, spend } from '../ledger/ledger.ts';
import { pushBalance } from '../live/actions.ts';
import { notify } from './notify.ts';

export interface Dm {
  id: number;
  sender_id: number;
  recipient_id: number;
  body: string;
  price: number;
  created_at: Date;
  read_at: Date | null;
}

async function conversationExists(ctx: Ctx, a: number, b: number): Promise<boolean> {
  return Boolean(
    await ctx.db.one(
      'select 1 from dm_messages where (sender_id = $1 and recipient_id = $2) or (sender_id = $2 and recipient_id = $1) limit 1',
      [a, b],
    ),
  );
}

/**
 * Who can message whom:
 * - Anyone (verified) can message an approved creator, paying their per-message price if they set one.
 * - A creator can reply to someone who already wrote to them (free). Admins can message anyone.
 * - Nobody can message someone who banned them from their room.
 */
export async function sendDm(ctx: Ctx, sender: User, recipientId: number, text: string): Promise<Dm> {
  const body = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, 2000);
  if (!body) throw new UserError('Write a message.');
  if (recipientId === sender.id) throw new UserError('You cannot message yourself.');
  const recipient = await ctx.db.one<{ id: number; display_name: string; status: string; creator_status: string; dm_price: number | null }>(
    `select u.id, u.display_name, u.status, u.creator_status, p.dm_price from users u
     left join creator_profiles p on p.user_id = u.id where u.id = $1`,
    [recipientId],
  );
  if (!recipient || recipient.status !== 'active') throw new UserError('That account does not exist or is not active.');
  const banned = await ctx.db.one(
    'select 1 from room_bans where (creator_id = $1 and user_id = $2) or (creator_id = $2 and user_id = $1)',
    [recipientId, sender.id],
  );
  if (banned && !sender.is_admin) throw new UserError('You cannot message this person.');
  const recipientIsCreator = recipient.creator_status === 'approved';
  if (!sender.is_admin && !recipientIsCreator && !(await conversationExists(ctx, sender.id, recipientId))) {
    throw new UserError('You can only message creators, or reply to someone who messaged you.');
  }
  // Whoever writes to a creator pays; the creator replies for free.
  const price = recipientIsCreator && !sender.is_admin && sender.creator_status !== 'approved' ? (recipient.dm_price ?? 0) : 0;
  const { economy } = await ctx.settings.get();
  let dm: Dm;
  try {
    dm = await ctx.db.tx(async (q) => {
      let txId: number | null = null;
      if (price > 0) {
        txId = await spend(q, {
          kind: 'dm',
          fromUser: sender.id,
          toCreator: recipientId,
          tokens: price,
          creatorSharePct: economy.creatorSharePct,
          memo: `Message to ${recipient.display_name}`,
          meta: {},
        });
      }
      return (await q.one<Dm>(
        'insert into dm_messages (sender_id, recipient_id, body, price, tx_id) values ($1, $2, $3, $4, $5) returning *',
        [sender.id, recipientId, body, price, txId],
      ))!;
    });
  } catch (err) {
    if (err instanceof InsufficientFunds) throw new UserError(`Each message costs ${price} tokens and you do not have enough.`);
    throw err;
  }
  if (price > 0) await pushBalance(ctx, sender.id);
  const live = { type: 'dm', id: dm.id, from: sender.display_name, fromId: sender.id, body: dm.body, at: dm.created_at };
  ctx.hub.toUser(recipientId, live);
  ctx.hub.toUser(sender.id, { ...live, mine: true, toId: recipientId });
  await notify(ctx, recipientId, { kind: 'dm', title: `Message from ${sender.display_name}`, body: dm.body.slice(0, 120), url: `/messages/${sender.id}` });
  return dm;
}

export async function conversations(ctx: Ctx, userId: number) {
  return ctx.db.query<{ other_id: number; name: string; last_body: string; last_at: Date; unread: number }>(
    `with mine as (
       select case when sender_id = $1 then recipient_id else sender_id end as other_id, id, body, created_at,
              (recipient_id = $1 and read_at is null) as unread
       from dm_messages where sender_id = $1 or recipient_id = $1
     )
     select m.other_id, u.display_name as name,
       (select body from mine x where x.other_id = m.other_id order by id desc limit 1) as last_body,
       max(m.created_at) as last_at, count(*) filter (where m.unread)::int as unread
     from mine m join users u on u.id = m.other_id
     group by m.other_id, u.display_name order by max(m.id) desc`,
    [userId],
  );
}

export async function thread(ctx: Ctx, userId: number, otherId: number): Promise<Dm[]> {
  const rows = await ctx.db.query<Dm>(
    `select * from dm_messages where (sender_id = $1 and recipient_id = $2) or (sender_id = $2 and recipient_id = $1)
     order by id desc limit 200`,
    [userId, otherId],
  );
  await ctx.db.query('update dm_messages set read_at = now() where recipient_id = $1 and sender_id = $2 and read_at is null', [userId, otherId]);
  return rows.reverse();
}
