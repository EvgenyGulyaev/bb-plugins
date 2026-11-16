import { Icon } from "@/components/ui/icon";
import { sanitizeSvg } from "@/lib/sanitize-svg";
import type { FamilyMark } from "@/lib/model-marks";

/**
 * Марка семейства: иконка BB, короткий текст или inline SVG (только после
 * повторной клиентской проверки — kv считается недоверенным входом).
 */
export function ModelMark({ mark, label, className }: { mark: FamilyMark; label: string; className?: string }) {
  if (mark.kind === "svg") {
    const svg = sanitizeSvg(mark.value);
    if (!svg) return null;
    return (
      <span
        role="img"
        title={label}
        aria-label={label}
        className={`inline-flex shrink-0 items-center [&_svg]:size-3 [&_svg]:shrink-0 ${className ?? ""}`}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  }
  if (mark.kind === "text") {
    return (
      <span
        title={label}
        aria-label={label}
        className={`shrink-0 rounded bg-muted/60 px-1 text-[10px] font-semibold leading-4 text-foreground ${className ?? ""}`}
      >
        {mark.value}
      </span>
    );
  }
  return <Icon name={mark.value} fallback="Zap" className={`size-3 shrink-0 ${className ?? ""}`} aria-label={label} />;
}
