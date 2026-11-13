import { appearancePayload, buildSamplePackage, databasePayload, documentPayload, linkRulesPayload, previewImage, whiteboardPayload, workflowPayload, type PackageSpec } from "../lib/sample-packages";

export const docSpec = (over: Partial<PackageSpec> = {}): PackageSpec => ({
  kind: "document",
  title: "Testvorlage",
  summary: { de: "Kurz", en: "Short" },
  category: "projects",
  tags: ["test"],
  payload: [documentPayload("Testvorlage", "projects", "<h1>Hallo</h1>")],
  previews: [previewImage("document", "#3b3fd8")],
  ...over,
});
export const docPackage = (over: Partial<PackageSpec> = {}) => buildSamplePackage(docSpec(over));
export const workflowPackage = (config: Record<string, unknown> = {}) =>
  buildSamplePackage({
    kind: "workflow",
    title: "WF",
    summary: { en: "A workflow" },
    category: "other",
    payload: [
      workflowPayload(
        "WF",
        [
          { id: "n_trigger1", type: "trigger.manual", label: "Start", x: 0, y: 0 },
          { id: "n_http0001", type: "http.request", label: "Call", x: 200, y: 0, config: { url: "https://api.example.com/v1/items", headers: [{ name: "Authorization", value: "Bearer abcdefghijklmnopqrstuvwxyz123456" }], ...config } },
          { id: "n_ai000001", type: "ai.summarize", label: "Sum", x: 400, y: 0 },
          { id: "n_mail0001", type: "notify.email", label: "Mail", x: 600, y: 0 },
        ],
        [
          ["n_trigger1", "n_http0001"],
          ["n_http0001", "n_ai000001"],
          ["n_ai000001", "n_mail0001"],
        ],
      ),
    ],
  });
export const allKindPackages = () => [
  docPackage(),
  buildSamplePackage({ kind: "database", title: "DB", summary: { de: "DB" }, category: "planning", payload: [databasePayload("DB", "planning", [{ id: "f1", name: "Name", type: "text" }], [{ f1: "x" }])] }),
  workflowPackage(),
  buildSamplePackage({ kind: "whiteboard", title: "WB", summary: { de: "WB" }, category: "meetings", payload: [whiteboardPayload("WB", [{ id: "s1", type: "sticky", x: 0, y: 0, w: 10, h: 10 }])] }),
  buildSamplePackage({ kind: "appearance", title: "Look", summary: { de: "Look" }, category: "other", payload: [appearancePayload({ accent: "#2f6f5e" })] }),
  buildSamplePackage({ kind: "link-rules", title: "Links", summary: { de: "Links" }, category: "knowledge", payload: [linkRulesPayload([{ name: "Issue", pattern: "#(\\d+)", template: "https://example.org/issues/$1" }])] }),
];
// The author's form: the English title is required; by default both titles
// are the given `title` (so tests that only set `title` keep their title).
export const form = (over: Record<string, unknown> = {}) => ({
  title: "Testvorlage",
  titleDe: typeof over.title === "string" ? over.title : "Testvorlage",
  titleEn: typeof over.title === "string" ? over.title : "Testvorlage",
  summaryDe: "Kurz",
  summaryEn: "Short",
  descriptionDe: "",
  descriptionEn: "",
  category: "projects",
  tags: ["test"],
  language: "de",
  minVersion: "0.9.4",
  license: "CC-BY-4.0",
  rights: true,
  changelog: "",
  ...over,
});
