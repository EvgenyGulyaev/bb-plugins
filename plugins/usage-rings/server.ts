import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { contract, resetHostContract, preferencesSchema, usageResponseSchema, type Overview } from "./contract.ts";
import { orderedProviders } from "./limits.ts";

const externalResourceListSchema = z.object({ resources: z.array(z.object({
  id: z.string(), providerId: z.string(), label: z.string(),
  scope: z.object({ kind: z.enum(["shared", "host"]), hostId: z.string().optional() }),
})) });
const externalUsageSchema = z.object({
  usage: z.object({
    status: z.string(), accountEmail: z.string().nullable().optional(), planLabel: z.string().nullable().optional(),
    windows: z.array(z.object({ label: z.string(), usedPercent: z.number(), resetsAt: z.string().nullable().optional() })).optional(),
  }),
});

export default function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: resetHostContract });
  async function readExternalUsage(hostId: string | null, providers: any[], refresh = false, signal?: AbortSignal) {
    const methods = await bb.sdk.plugins.experimental_discoverRpc({ method: "provider-usage.v1.listResources", signal });
    const listMethods = methods.filter(method => method.method === "provider-usage.v1.listResources");
    const result: { providerId: string; id: string; label: string; usage: any }[] = [];
    for (const method of listMethods) {
      const listed = externalResourceListSchema.parse(await bb.sdk.plugins.callRpc({
        pluginId: method.pluginId, method: method.method, input: {}, outputSchema: externalResourceListSchema, signal,
      }));
      const getMethod = methods.find(candidate => candidate.pluginId === method.pluginId && candidate.method === "provider-usage.v1.getResource");
      if (!getMethod) continue;
      for (const resource of listed.resources) {
        if (resource.scope.kind === "host" && resource.scope.hostId !== hostId) continue;
        try {
          const data = externalUsageSchema.parse(await bb.sdk.plugins.callRpc({
            pluginId: getMethod.pluginId, method: getMethod.method,
            input: { resourceId: resource.id, refresh }, outputSchema: externalUsageSchema, signal,
          }));
          result.push({ providerId: resource.providerId, id: resource.id, label: resource.label, usage: data.usage });
        } catch { /* One external provider must not hide native limits. */ }
      }
    }
    return result.map(resource => ({
      ...resource,
      displayName: providers.find(provider => provider.id === resource.providerId)?.displayName ?? resource.label,
    }));
  }
  async function resetTarget(input: { hostId: string | null; accountId: string }, signal?: AbortSignal) {
    const hostId = input.hostId ?? (await bb.sdk.system.config()).primaryHostId;
    if (!hostId) throw new Error("Выберите компьютер с установленным Codex CLI.");
    const data = await read(hostId, false, signal);
    if (data.error) throw new Error(data.error);
    const account = data.providers.find(p => p.id === "codex")?.accounts.find(a => a.id === input.accountId);
    const email = account?.usage?.status === "ok" ? account.usage.accountEmail : null;
    if (!email) throw new Error("Аккаунт Codex не определён. Обновите лимиты и проверьте вход.");
    return { hostId, email };
  }
  async function preferences() {
    return preferencesSchema.parse(await bb.storage.kv.get("providers") ?? []);
  }
  async function read(hostId: string | null, force = false, signal?: AbortSignal): Promise<Overview> {
    const selectedHost = hostId ?? (await bb.sdk.system.config()).primaryHostId;
    const [saved, nativeRoster, allRoster] = await Promise.all([
      preferences(),
      bb.sdk.providers.list(selectedHost ? { capability: "usage", hostId: selectedHost } : { capability: "usage" }),
      bb.sdk.providers.list(selectedHost ? { hostId: selectedHost } : {}),
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
      const enabled = nativeRoster.filter(provider => saved.find(p => p.id === provider.id)?.enabled
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
    let external: Awaited<ReturnType<typeof readExternalUsage>> = [];
    try { external = await readExternalUsage(selectedHost, allRoster, force, signal); } catch { /* Native provider limits remain available. */ }
    const externalProviders = external.map(resource => allRoster.find(provider => provider.id === resource.providerId) ?? {
      id: resource.providerId, displayName: resource.displayName, logoUrl: null, icon: null, strings: null,
    });
    const roster = [...nativeRoster, ...externalProviders.filter(provider => !nativeRoster.some(native => native.id === provider.id))];
    const providers = roster.map(provider => {
      const accounts = [
        ...(machine?.providers.filter(p => p.providerId === provider.id) ?? []),
        ...external.filter(resource => resource.providerId === provider.id).map(resource => ({
          id: resource.id, accountLabel: resource.label,
          usage: resource.usage.status === "ok" ? {
            status: "ok" as const, accountEmail: resource.usage.accountEmail ?? null,
            planLabel: resource.usage.planLabel ?? null,
            windows: (resource.usage.windows ?? []).map((window: { label: string; usedPercent: number; resetsAt?: string | null }) => ({ label: window.label, usedPercent: window.usedPercent, resetsAt: window.resetsAt ?? null })),
          } : { status: "error" as const, message: "Не удалось получить лимиты." },
        })),
      ];
      return {
        id: provider.id, displayName: provider.displayName, logoUrl: provider.logoUrl ?? null, icon: provider.icon ?? null,
        strings: { iconTint: provider.strings?.iconTint ?? null }, accounts,
        enabled: saved.find(p => p.id === provider.id)?.enabled ?? accounts.some(p => p.usage?.status !== "not_installed"),
      };
    });
    return { providers: orderedProviders(providers, saved), preferences: saved, machineName: machine?.displayName ?? null, error };
  }
  bb.rpc.register(contract, {
    async resets(input, context) {
      const target = await resetTarget(input, context.experimental_signal);
      return host.call("readResets", { expectedEmail: target.email }, { hostId: target.hostId, signal: context.experimental_signal, timeoutMs: 60_000 });
    },
    async consumeReset(input, context) {
      const target = await resetTarget(input, context.experimental_signal);
      try {
        return await host.call("consumeReset", {
          expectedEmail: target.email, expectedAccountId: input.expectedAccountId,
          creditId: input.creditId, idempotencyKey: input.idempotencyKey, confirmed: input.confirmed,
        }, { hostId: target.hostId, signal: context.experimental_signal, timeoutMs: 60_000 });
      } finally { bb.rpc.experimental_invalidate(["usage-rings"]); }
    },
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
