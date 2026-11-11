import { FileText } from "@phosphor-icons/react/dist/ssr/FileText";
import { Table } from "@phosphor-icons/react/dist/ssr/Table";
import { FlowArrow } from "@phosphor-icons/react/dist/ssr/FlowArrow";
import { Shapes } from "@phosphor-icons/react/dist/ssr/Shapes";
import { Palette } from "@phosphor-icons/react/dist/ssr/Palette";
import { LinkSimple } from "@phosphor-icons/react/dist/ssr/LinkSimple";

export function KindIcon({ kind, size = 16 }: { kind: string; size?: number }) {
  const Icon = { document: FileText, database: Table, workflow: FlowArrow, whiteboard: Shapes, appearance: Palette, "link-rules": LinkSimple }[kind] ?? FileText;
  return <Icon size={size} weight="duotone" aria-hidden="true" />;
}
