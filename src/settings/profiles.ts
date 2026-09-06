import { appSettingsSchema, type AppSettings, type ProviderSettings } from "@/shared/schema";
import { createId } from "@/shared/token";

/** Commit the editor/active model without changing any other profile's credentials. */
export function updateActiveProvider(settings: AppSettings, provider: ProviderSettings): AppSettings {
  const id = settings.activeProviderId ?? createId("provider");
  const exists = settings.providers.some((profile) => profile.id === id);
  return appSettingsSchema.parse({
    ...settings,
    activeProviderId: id,
    providers: exists
      ? settings.providers.map((profile) =>
          profile.id === id ? { ...profile, settings: provider } : profile,
        )
      : [...settings.providers, { id, name: "Default provider", settings: provider }],
  });
}

export function selectProvider(settings: AppSettings, providerId: string): AppSettings {
  return appSettingsSchema.parse({ ...settings, activeProviderId: providerId });
}
