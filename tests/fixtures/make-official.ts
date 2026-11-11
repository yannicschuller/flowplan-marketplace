// Writes the official-template fixtures in tests/fixtures/official/ (stand-ins
// for what Flowplan's `npm run marketplace-official` puts into seed/official/):
//   node --import tsx tests/fixtures/make-official.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSamplePackage, documentPayload, previewImage, whiteboardPayload, workflowPayload, type PackageSpec } from "../../lib/sample-packages";

export const officialSpecs: Record<string, PackageSpec> = {
  "meeting-notes": {
    kind: "document",
    title: "Besprechungsnotizen",
    summary: { de: "Agenda, Notizen, Entscheidungen und Aufgaben für jede Besprechung.", en: "Agenda, notes, decisions and action items for every meeting." },
    description: { de: "Die eingebaute Vorlage aus Flowplan.", en: "The template built into Flowplan." },
    category: "meetings",
    tags: ["meeting"],
    language: "multi",
    payload: [documentPayload("Besprechungsnotizen", "meetings", "<h1>Besprechung</h1><h2>Agenda</h2><ol><li><p></p></li></ol><h2>Entscheidungen</h2><ul><li><p></p></li></ul>")],
    previews: [previewImage("document", "#3b3fd8", 0)],
  },
  "brainstorming": {
    kind: "whiteboard",
    title: "Brainstorming",
    summary: { de: "Ideen sammeln und clustern.", en: "Collect and cluster ideas." },
    category: "planning",
    tags: ["ideas"],
    language: "multi",
    payload: [whiteboardPayload("Brainstorming", [{ id: "s1", type: "sticky", x: 0, y: 0, w: 200, h: 120, text: "", fill: "#ffe58a" }])],
    previews: [previewImage("whiteboard", "#4cb782", 0)],
  },
  "weekly-report": {
    kind: "workflow",
    title: "Wochenbericht",
    summary: { de: "Jeden Freitag die erledigten Aufgaben per E-Mail.", en: "Every Friday the tasks done, by e-mail." },
    category: "planning",
    language: "multi",
    payload: [
      workflowPayload(
        "Wochenbericht",
        [
          { id: "n_sched01", type: "trigger.schedule", label: "Freitag", x: 0, y: 0, config: { cron: "0 16 * * 5" } },
          { id: "n_mail001", type: "notify.email", label: "Bericht", x: 280, y: 0, config: { to: ["@runner"], subject: "Wochenbericht" } },
        ],
        [["n_sched01", "n_mail001"]],
      ),
    ],
  },
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = join(import.meta.dirname, "official");
  for (const [key, spec] of Object.entries(officialSpecs)) writeFileSync(join(dir, `${key}.flowplan-template`), buildSamplePackage(spec));
  console.log(`Wrote ${Object.keys(officialSpecs).length} packages to ${dir}`);
}
