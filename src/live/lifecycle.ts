/** Start and end a live broadcast in one place (legal session, recording, private shows, state). */
import type { Ctx } from '../context.ts';
import { audit, type User } from '../auth/users.ts';
import { canBroadcast } from '../access.ts';
import { closeSession, currentSession, openSession } from '../compliance/records.ts';
import { ActionError, pushState } from './actions.ts';
import { publicRoom } from './livekit.ts';
import { closeCreatorPrivates } from './privates.ts';
import { endTicketShow } from './tickets.ts';
import { closePoll } from './engage.ts';
import { resetPeak } from './stats.ts';
import { notifyFollowers } from '../notify/notify.ts';

export type BroadcastMode = 'browser' | 'obs';

export async function startLive(ctx: Ctx, user: User, coPerformerIds: number[], mode: BroadcastMode = 'browser'): Promise<number> {
  const can = await canBroadcast(ctx, user);
  if (!can.ok) throw new ActionError(can.reason!);
  const profile = await ctx.db.one<{ room_title: string; ingress_id: string | null }>(
    'select room_title, ingress_id from creator_profiles where user_id = $1',
    [user.id],
  );
  if (!profile) throw new ActionError('You do not have a creator profile.');
  if (mode === 'obs' && (!ctx.cfg.ingressEnabled || !profile.ingress_id)) throw new ActionError('First create your OBS key in Studio → OBS.');
  const sessionId = await openSession(ctx, user, profile.room_title, coPerformerIds);
  await ctx.db.query('update creator_profiles set is_live = true, live_since = now(), broadcast_mode = $2 where user_id = $1', [user.id, mode]);
  await audit(ctx.db, user.id, 'live.start', { sessionId, coPerformerIds, mode });
  resetPeak(user.id);
  // Notify followers without delaying the start of the broadcast.
  const slug = await ctx.db.one<{ slug: string }>('select slug from creator_profiles where user_id = $1', [user.id]);
  void notifyFollowers(ctx, user.id, { kind: 'live', title: `${user.display_name} is live`, body: profile.room_title, url: `/c/${slug?.slug}` }).catch(
    (err) => console.error('notifyFollowers', err),
  );
  await startEgress(ctx, user.id, sessionId);
  await pushState(ctx, user.id);
  return sessionId;
}

/** Recording (copy of the broadcast) and HLS, if the server has Egress and they are enabled. */
async function startEgress(ctx: Ctx, creatorId: number, sessionId: number): Promise<void> {
  if (!ctx.cfg.egressEnabled) return;
  const { media } = await ctx.settings.get();
  const room = publicRoom(creatorId);
  if (media.record) {
    const rel = `recordings/${creatorId}/session-${sessionId}.mp4`;
    try {
      const id = await ctx.media.startRecording(room, rel);
      await ctx.db.query('update broadcast_sessions set egress_id = $2, recording_path = $3 where id = $1', [sessionId, id, rel]);
    } catch (err) {
      await audit(ctx.db, null, 'recording.failed', { sessionId, error: (err as Error).message });
    }
  }
  if (media.hls) {
    const dir = `hls/${creatorId}/${sessionId}`;
    try {
      const id = await ctx.media.startHls(room, dir);
      await ctx.db.query('update broadcast_sessions set hls_egress_id = $2, hls_path = $3 where id = $1', [sessionId, id, dir]);
    } catch (err) {
      await audit(ctx.db, null, 'hls.failed', { sessionId, error: (err as Error).message });
    }
  }
}

export async function stopEgressSafe(ctx: Ctx, egressId: string | null | undefined): Promise<void> {
  if (!egressId) return;
  try {
    await ctx.media.stopEgress(egressId);
  } catch (err) {
    await audit(ctx.db, null, 'egress.stop_failed', { egressId, error: (err as Error).message });
  }
}

export async function endLive(ctx: Ctx, creatorId: number, reason: string): Promise<void> {
  await closeCreatorPrivates(ctx, creatorId, reason);
  await endTicketShow(ctx, creatorId, 'The live broadcast has ended');
  await closePoll(ctx, creatorId);
  await ctx.db.query('update creator_profiles set is_live = false where user_id = $1', [creatorId]);
  const session = await currentSession(ctx.db, creatorId);
  if (session) {
    const s = await ctx.db.one<{ egress_id: string | null; hls_egress_id: string | null }>(
      'select egress_id, hls_egress_id from broadcast_sessions where id = $1',
      [session.id],
    );
    await stopEgressSafe(ctx, s?.egress_id);
    await stopEgressSafe(ctx, s?.hls_egress_id);
  }
  await closeSession(ctx.db, creatorId);
  ctx.hub.clearHistory(creatorId);
  await pushState(ctx, creatorId);
}

