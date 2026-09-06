import {
  DEFAULT_SETTINGS,
  appSettingsSchema,
  type AppSettings,
  type ProviderSettings,
} from "@/shared/schema";

import { updateActiveProvider } from "./profiles";

const SETTINGS_KEY = "browseragent.settings.v1";

export class SettingsRepository {
  async load(): Promise<AppSettings> {
    const stored = await browser.storage.local.get(SETTINGS_KEY);
    const parsed = appSettingsSchema.safeParse(stored[SETTINGS_KEY]);
    return parsed.success ? parsed.data : DEFAULT_SETTINGS;
  }

  async save(settings: AppSettings): Promise<void> {
    const parsed = appSettingsSchema.parse(settings);
    await browser.storage.local.set({ [SETTINGS_KEY]: parsed });
  }

  async saveProvider(provider: ProviderSettings): Promise<AppSettings> {
    const current = await this.load();
    const next = updateActiveProvider(current, provider);
    await this.save(next);
    return next;
  }
}
