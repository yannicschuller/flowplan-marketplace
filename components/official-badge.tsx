import { SealCheck } from "@phosphor-icons/react/dist/ssr/SealCheck";
import type { T } from "@/lib/i18n";

// Marks the templates of the built-in author "Flowplan" (lib/official.ts).
export function OfficialBadge({ t }: { t: T }) {
  return (
    <span className="official-badge" title={t("Offizielle Vorlage von Flowplan", "Official template by Flowplan")}>
      <SealCheck size={14} weight="fill" aria-hidden="true" />
      {t("Offiziell", "Official")}
    </span>
  );
}
