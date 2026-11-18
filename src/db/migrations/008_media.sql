-- Streaming from OBS (LiveKit Ingress), recordings and HLS (LiveKit Egress).
alter table creator_profiles add column broadcast_mode text not null default 'browser' check (broadcast_mode in ('browser', 'obs'));
alter table creator_profiles add column ingress_id text;
alter table creator_profiles add column ingress_url text;
alter table creator_profiles add column ingress_key_enc text;
alter table broadcast_sessions add column egress_id text;
alter table broadcast_sessions add column hls_egress_id text;
alter table broadcast_sessions add column hls_path text;
alter table private_shows add column egress_id text;
alter table private_shows add column recording_path text;
