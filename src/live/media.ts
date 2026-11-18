/**
 * Optional LiveKit media services:
 * - Ingress (OBS over RTMP or WHIP): https://docs.livekit.io/transport/self-hosting/ingress/
 * - Egress (MP4 recording and HLS): https://docs.livekit.io/transport/self-hosting/egress/
 * Both need Redis and their own containers (the “obs” and “recording” docker compose profiles).
 */
import { join } from 'node:path';
import {
  EgressClient,
  EncodedFileOutput,
  EncodedFileType,
  IngressClient,
  IngressInput,
  SegmentedFileOutput,
  SegmentedFileProtocol,
} from 'livekit-server-sdk';
import type { Config } from '../config.ts';

export interface IngressResult {
  ingressId: string;
  url: string;
  streamKey: string;
}

export interface MediaServices {
  createIngress(opts: { roomName: string; identity: string; name: string; kind: 'rtmp' | 'whip' }): Promise<IngressResult>;
  deleteIngress(ingressId: string): Promise<void>;
  /** Records the room to an MP4. `relativePath` is relative to the media folder. */
  startRecording(roomName: string, relativePath: string): Promise<string>;
  /** Records only one participant's tracks (e.g. the creator in a private show with cam2cam). */
  startParticipantRecording(roomName: string, identity: string, relativePath: string): Promise<string>;
  /** Generates HLS for the room in `relativeDir` (index.m3u8 and live.m3u8). */
  startHls(roomName: string, relativeDir: string): Promise<string>;
  stopEgress(egressId: string): Promise<void>;
}

export function createMediaServices(cfg: Config): MediaServices {
  const ingress = new IngressClient(cfg.livekitApiUrl, cfg.livekitApiKey, cfg.livekitApiSecret);
  const egress = new EgressClient(cfg.livekitApiUrl, cfg.livekitApiKey, cfg.livekitApiSecret);
  const out = (rel: string) => `${cfg.egressOutputDir}/${rel}`;
  return {
    async createIngress({ roomName, identity, name, kind }) {
      const info = await ingress.createIngress(kind === 'rtmp' ? IngressInput.RTMP_INPUT : IngressInput.WHIP_INPUT, {
        name: `ftw-${identity}`,
        roomName,
        participantIdentity: identity,
        participantName: name,
        // RTMP needs transcoding; WHIP does not by default.
        enableTranscoding: kind === 'rtmp',
      });
      return { ingressId: info.ingressId, url: info.url, streamKey: info.streamKey };
    },
    async deleteIngress(ingressId) {
      await ingress.deleteIngress(ingressId);
    },
    async startRecording(roomName, relativePath) {
      const info = await egress.startRoomCompositeEgress(
        roomName,
        new EncodedFileOutput({ fileType: EncodedFileType.MP4, filepath: out(relativePath) }),
        { layout: 'speaker' },
      );
      return info.egressId;
    },
    async startParticipantRecording(roomName, identity, relativePath) {
      const info = await egress.startParticipantEgress(roomName, identity, {
        file: new EncodedFileOutput({ fileType: EncodedFileType.MP4, filepath: out(relativePath) }),
      });
      return info.egressId;
    },
    async startHls(roomName, relativeDir) {
      const info = await egress.startRoomCompositeEgress(
        roomName,
        new SegmentedFileOutput({
          protocol: SegmentedFileProtocol.HLS_PROTOCOL,
          filenamePrefix: out(join(relativeDir, 'seg')),
          playlistName: 'index.m3u8',
          livePlaylistName: 'live.m3u8',
          segmentDuration: 4,
        }),
        { layout: 'speaker' },
      );
      return info.egressId;
    },
    async stopEgress(egressId) {
      await egress.stopEgress(egressId);
    },
  };
}
