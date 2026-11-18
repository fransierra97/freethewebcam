import { AccessToken } from 'livekit-server-sdk';
import type { Config } from '../config.ts';

export const publicRoom = (creatorId: number) => `public-${creatorId}`;
export const privateRoom = (showId: number) => `private-${showId}`;
export const ticketRoom = (showId: number) => `ticket-${showId}`;

export async function liveToken(
  cfg: Config,
  opts: { identity: string; name: string; room: string; publish: boolean },
): Promise<string> {
  const token = new AccessToken(cfg.livekitApiKey, cfg.livekitApiSecret, {
    identity: opts.identity,
    name: opts.name,
    ttl: '2h',
  });
  token.addGrant({
    roomJoin: true,
    room: opts.room,
    canPublish: opts.publish,
    canSubscribe: true,
    // Chat goes through our (moderated) WebSocket, not LiveKit data channels.
    canPublishData: false,
  });
  return token.toJwt();
}
