import type { Config } from './config.ts';
import type { Db } from './db/index.ts';
import type { Hub } from './live/hub.ts';
import type { ProviderService } from './providers/service.ts';
import type { SettingsStore } from './settings.ts';
import type { MediaServices } from './live/media.ts';

export interface Ctx {
  cfg: Config;
  db: Db;
  settings: SettingsStore;
  providers: ProviderService;
  hub: Hub;
  media: MediaServices;
}
