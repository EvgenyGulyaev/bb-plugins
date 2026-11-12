import type { FileManagerMachine } from "../contract";

export interface MachineSelectorProps {
  machines: readonly FileManagerMachine[];
  value: string | null;
  onChange: (hostId: string) => void;
}

function statusLabel(machine: FileManagerMachine): string {
  if (machine.status === "connected") return "подключена";
  if (machine.status === "creating") return "подключается";
  if (machine.status === "offline") return "не подключена";
  return "состояние неизвестно";
}

export function MachineSelector({ machines, value, onChange }: MachineSelectorProps) {
  if (machines.length < 2) return null;
  return (
    <label className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/20 px-3 py-2 text-xs">
      <span className="text-muted-foreground">Машина</span>
      <select
        className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm text-foreground"
        value={value ?? ""}
        aria-label="Машина для файлов"
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {machines.map((machine) => (
          <option key={machine.id} value={machine.id} disabled={machine.root === null}>
            {machine.name} — {statusLabel(machine)}
          </option>
        ))}
      </select>
    </label>
  );
}
