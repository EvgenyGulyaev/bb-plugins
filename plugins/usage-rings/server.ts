import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { contract, preferencesSchema, usageResponseSchema, type Overview } from "./contract.ts";
import { orderedProviders } from "./limits.ts";

export default function plugin(bb: BbPluginApi) {
  async function preferences() {
    return preferencesSchema.parse(await bb.storage.kv.get("providers") ?? []);
  }
  async function read(hostId: string | null, force = false, signal?: AbortSignal): Promise<Overview> {
    const selectedHost = hostId ?? (await bb.sdk.system.config()).primaryHostId;
    const [saved, roster] = await Promise.all([
      preferences(),
      bb.sdk.providers.list(selectedHost ? { capability: "usage", hostId: selectedHost } : { capability: "usage" }),
    ]);
    const input = { force: false, machineIds: selectedHost ? [selectedHost] : null, providerIds: [] as string[], maxAgeMs: 60_000 };
    const getUsage = (args: typeof input) => bb.sdk.plugins.callRpc({
      pluginId: "bb--provider-usage", method: "getUsage", input: args, outputSchema: usageResponseSchema, signal,
    });
    let machine: Awaited<ReturnType<typeof getUsage>>["machines"][number] | undefined;
    let error: string | null = null;
    try {
      const inventory = await getUsage(input);
      machine = selectedHost ? inventory.machines.find(m => m.id === selectedHost) : inventory.machines.find(m => m.status === "connected");
      const enabled = roster.filter(provider => saved.find(p => p.id === provider.id)?.enabled
        ?? machine?.providers.some(p => p.providerId === provider.id && p.usage?.status !== "not_installed") ?? false);
      if (machine?.status === "connected" && enabled.length) {
        const machineId = machine.id;
        const loaded = await getUsage({ ...input, machineIds: [machineId], providerIds: enabled.map(p => p.id), force });
        machine = loaded.machines.find(m => m.id === machineId);
      }
      error = !machine ? "Компьютер с данными лимитов не найден."
        : machine.status !== "connected" ? "Компьютер отключён. Данные не обновлены."
        : machine.error ? "Не удалось обновить лимиты. Данные могут быть устаревшими." : null;
    } catch {
      error = "Не удалось прочитать лимиты. Проверьте, включён ли встроенный Provider Usage.";
    }
    const providers = roster.map(provider => {
      const accounts = machine?.providers.filter(p => p.providerId === provider.id) ?? [];
      return {
        id: provider.id, displayName: provider.displayName, logoUrl: provider.logoUrl ?? null, icon: provider.icon ?? null,
        strings: { iconTint: provider.strings?.iconTint ?? null }, accounts,
        enabled: saved.find(p => p.id === provider.id)?.enabled ?? accounts.some(p => p.usage?.status !== "not_installed"),
      };
    });
    return { providers: orderedProviders(providers, saved), preferences: saved, machineName: machine?.displayName ?? null, error };
  }
  bb.rpc.register(contract, {
    overview: ({ hostId }, context) => read(hostId, false, context.experimental_signal),
    async savePreferences(rows) {
      await bb.storage.kv.set("providers", rows);
      bb.rpc.experimental_invalidate(["usage-rings"]);
      return rows;
    },
    async refresh({ hostId }, context) {
      const result = await read(hostId, true, context.experimental_signal);
      bb.rpc.experimental_invalidate(["usage-rings"]);
      if (result.error) throw new Error(result.error);
      return null;
    },
  });
  for (const event of ["thread.idle", "thread.failed"] as const) {
    bb.events.on(event, () => { bb.rpc.experimental_invalidate(["usage-rings"]); });
  }
}
