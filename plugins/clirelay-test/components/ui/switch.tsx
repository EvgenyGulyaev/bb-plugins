// Тумблер вкл/выкл (role=switch, без новых зависимостей). Вынесен из app.tsx,
// чтобы вкладка «Настройки» не импортировала app.tsx циклически.
export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label}
      onClick={(event) => { event.stopPropagation(); onChange(!checked); }}
      className={`relative h-4.5 w-8 shrink-0 rounded-full transition-colors ${checked ? "bg-emerald-500" : "bg-muted-foreground/30"}`}>
      <span className={`absolute top-0.5 left-0.5 size-3.5 rounded-full bg-background shadow-sm transition-transform ${checked ? "translate-x-3.5" : ""}`} />
    </button>
  );
}