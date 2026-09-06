import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appSettingsSchema, DEFAULT_SETTINGS } from "@/shared/schema";
import { providerRequest } from "@/test/providerFixture";
import { SettingsRepository } from "./repository";
import { selectProvider, updateActiveProvider } from "./profiles";

const repository = new SettingsRepository();
let storage: Record<string, unknown>;
beforeEach(() => {
  storage = {};
  vi.stubGlobal("browser", {
    storage: {
      local: {
        get: vi.fn(async () => structuredClone(storage)),
        set: vi.fn(async (value: Record<string, unknown>) => {
          storage = structuredClone(value);
        }),
      },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

const provider = providerRequest().settings;
describe("provider profiles", () => {
  it("migrates the existing single provider without losing its key or model", async () => {
    storage["browseragent.settings.v1"] = { provider, mode: "interactive" };
    const loaded = await repository.load();
    expect(loaded).toMatchObject({ mode: "interactive", activeProviderId: "legacy", provider });
    expect(loaded.providers).toEqual([{ id: "legacy", name: "Default provider", settings: provider }]);
    await repository.save(loaded);
    expect(await repository.load()).toEqual(loaded);
  });

  it("keeps independent models and keys, including two keys for one endpoint", async () => {
    let settings = appSettingsSchema.parse({
      providers: [
        { id: "a", name: "Personal", settings: provider },
        { id: "b", name: "Work", settings: { ...provider, apiKey: "work-key", model: "work-model" } },
      ],
      activeProviderId: "a",
    });
    await repository.save(settings);
    settings = await repository.saveProvider({ ...provider, model: "new-model" });
    expect(settings.providers[1]?.settings.apiKey).toBe("work-key");
    settings = selectProvider(settings, "b");
    await repository.save(settings);
    expect((await repository.load()).provider).toMatchObject({ apiKey: "work-key", model: "work-model" });
    expect(selectProvider(settings, "a").provider?.model).toBe("new-model");
  });

  it("creates an initial profile and permanently removes credentials on deletion/save", async () => {
    const settings = updateActiveProvider(DEFAULT_SETTINGS, provider);
    expect(settings.providers).toHaveLength(1);
    await repository.save(settings);
    await repository.save({ ...settings, providers: [], activeProviderId: null, provider: null });
    expect(JSON.stringify(storage)).not.toContain("secret");
    expect(await repository.load()).toEqual(DEFAULT_SETTINGS);
  });

  it("rejects duplicate IDs and dangling selections rather than choosing a different credential", () => {
    const entry = { id: "a", name: "A", settings: provider };
    expect(() => appSettingsSchema.parse({ providers: [entry, entry] })).toThrow();
    expect(() => selectProvider(DEFAULT_SETTINGS, "missing")).toThrow();
    expect(() => appSettingsSchema.parse({ providers: [{ ...entry, name: " " }] })).toThrow();
  });
});
