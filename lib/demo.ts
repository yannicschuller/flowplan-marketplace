// Demo data (npm run demo, MARKETPLACE_DEMO=1): three authors, nine
// templates of every kind, most published, some waiting for review, one
// report – built through the same code paths as real submissions.
import { one, run } from "./db";
import { createUser, type User } from "./auth";
import { submit } from "./store";
import { decide, setFeatured } from "./admin";
import { appearancePayload, buildSamplePackage, databasePayload, documentPayload, linkRulesPayload, previewImage, whiteboardPayload, workflowPayload, type PackageSpec } from "./sample-packages";
import { createReport } from "./reports";

type Demo = { author: "demo" | "jonas" | "mei"; spec: PackageSpec; form?: Record<string, unknown>; status: "published" | "submitted" | "changes_requested"; downloads?: number; opens?: number; message?: string };

const ACCENT = "#3b3fd8";
const demos = (): Demo[] => [
  {
    author: "demo",
    status: "published",
    downloads: 412,
    opens: 238,
    spec: {
      kind: "document",
      title: "Meeting-Protokoll",
      summary: { de: "Agenda, Entscheidungen und Aufgaben in einer klaren Struktur – für jedes Teammeeting.", en: "Agenda, decisions and action items in one clear structure – for every team meeting." },
      description: {
        de: "## Was drin ist\n\n- **Agenda** mit Zeitfenstern\n- Abschnitt für *Entscheidungen*\n- Aufgabenliste mit Zuständigen\n\nFunktioniert gut zusammen mit der Datenbank-Vorlage [Aufgaben-Board](https://marketplace.flowplan.org/t/aufgaben-board).\n\n> Tipp: Lege die Vorlage als Standard für deinen Meeting-Bereich fest.",
        en: "## What's inside\n\n- **Agenda** with time slots\n- A section for *decisions*\n- Action items with owners\n\n> Tip: make it the default template of your meetings space.",
      },
      category: "meetings",
      tags: ["meeting", "protokoll", "team"],
      language: "de",
      payload: [documentPayload("Meeting-Protokoll", "meetings", "<h1>Meeting-Protokoll</h1><p><strong>Datum:</strong> </p><h2>Agenda</h2><ol><li><p>Begrüßung</p></li></ol><h2>Entscheidungen</h2><ul><li><p></p></li></ul><h2>Aufgaben</h2><ul data-type=\"taskList\"><li data-type=\"taskItem\" data-checked=\"false\"><p></p></li></ul>")],
      previews: [previewImage("document", ACCENT, 0), previewImage("document", "#4cb782", 1)],
    },
  },
  {
    author: "jonas",
    status: "published",
    downloads: 187,
    opens: 95,
    spec: {
      kind: "document",
      title: "Project brief",
      summary: { de: "Ziel, Umfang, Beteiligte und Meilensteine eines Projekts auf einer Seite.", en: "Goal, scope, people and milestones of a project on one page." },
      description: { en: "A one-page brief to align everyone before a project starts.\n\n1. Problem and goal\n2. Scope and non-goals\n3. Milestones\n4. Risks" },
      category: "projects",
      tags: ["project", "planning"],
      language: "en",
      payload: [documentPayload("Project brief", "projects", "<h1>Project brief</h1><h2>Goal</h2><p></p><h2>Scope</h2><p></p><h2>Milestones</h2><ul><li><p></p></li></ul><h2>Risks</h2><p></p>")],
      previews: [previewImage("document", "#f0663a", 2)],
    },
  },
  {
    author: "demo",
    status: "published",
    downloads: 655,
    opens: 402,
    spec: {
      kind: "database",
      title: "Aufgaben-Board",
      summary: { de: "Kanban-Board mit Status, Priorität und Fälligkeit – sofort einsatzbereit.", en: "Kanban board with status, priority and due date – ready to use." },
      description: { de: "Ein schlankes Board für kleine Teams. Spalten: *Offen*, *In Arbeit*, *Erledigt*.", en: "A lean board for small teams. Columns: *Open*, *In progress*, *Done*." },
      category: "projects",
      tags: ["kanban", "aufgaben", "board"],
      language: "multi",
      payload: [
        databasePayload(
          "Aufgaben-Board",
          "projects",
          [
            { id: "f-title", name: "Aufgabe", type: "text" },
            { id: "f-status", name: "Status", type: "select", options: ["Offen", "In Arbeit", "Erledigt"] },
            { id: "f-prio", name: "Priorität", type: "select", options: ["Hoch", "Mittel", "Niedrig"] },
            { id: "f-due", name: "Fällig", type: "date" },
          ],
          [
            { "f-title": "Kickoff vorbereiten", "f-status": "Erledigt", "f-prio": "Hoch" },
            { "f-title": "Entwurf teilen", "f-status": "In Arbeit", "f-prio": "Mittel" },
            { "f-title": "Feedback einarbeiten", "f-status": "Offen", "f-prio": "Mittel" },
          ],
          "board",
        ),
      ],
      previews: [previewImage("whiteboard", ACCENT, 1), previewImage("database", ACCENT, 0)],
    },
  },
  {
    author: "mei",
    status: "published",
    downloads: 98,
    opens: 61,
    spec: {
      kind: "database",
      title: "Reading log",
      summary: { de: "Bücher, Bewertungen und Notizen – dein persönliches Lesetagebuch.", en: "Books, ratings and notes – your personal reading log." },
      category: "personal",
      tags: ["books", "personal"],
      language: "en",
      payload: [
        databasePayload(
          "Reading log",
          "personal",
          [
            { id: "f-book", name: "Book", type: "text" },
            { id: "f-author", name: "Author", type: "text" },
            { id: "f-rating", name: "Rating", type: "select", options: ["★", "★★", "★★★", "★★★★", "★★★★★"] },
            { id: "f-done", name: "Finished", type: "date" },
          ],
          [{ "f-book": "The Pragmatic Programmer", "f-author": "Hunt & Thomas", "f-rating": "★★★★★" }],
        ),
      ],
      previews: [previewImage("database", "#4cb782", 1)],
    },
  },
  {
    author: "jonas",
    status: "published",
    downloads: 141,
    opens: 120,
    spec: {
      kind: "workflow",
      title: "Formularantwort an Slack",
      summary: { de: "Neue Formularantworten zusammenfassen und in einen Slack-Kanal posten.", en: "Summarise new form answers and post them to a Slack channel." },
      description: {
        de: "Wenn jemand dein Formular ausfüllt, fasst ein KI-Schritt die Antwort zusammen und schickt sie per Webhook an Slack.\n\nNach dem Import: Webhook-Adresse unter **Zugangsdaten** eintragen und den Workflow aktivieren – er kommt pausiert an.",
        en: "When someone fills in your form, an AI step summarises the answer and sends it to Slack via webhook.\n\nAfter importing: add the webhook address under **Credentials** and activate the workflow – it arrives paused.",
      },
      category: "projects",
      tags: ["slack", "formular", "ki"],
      language: "multi",
      payload: [
        workflowPayload(
          "Formularantwort an Slack",
          [
            { id: "n_trigger1", type: "trigger.form.submitted", label: "Formular ausgefüllt", x: 0, y: 0 },
            { id: "n_summary1", type: "ai.summarize", label: "Zusammenfassen", x: 280, y: 0, config: { text: "{{trigger.answers}}" } },
            { id: "n_slack01", type: "http.request", label: "An Slack", x: 560, y: 0, config: { method: "POST", url: "https://hooks.slack.com/services/{{credential}}", bodyKind: "json", body: '{"text":"{{n_summary1.text}}"}', credential: "" } },
          ],
          [
            ["n_trigger1", "n_summary1"],
            ["n_summary1", "n_slack01"],
          ],
        ),
      ],
      previews: [previewImage("workflow", "#f0663a", 0)],
    },
  },
  {
    author: "demo",
    status: "published",
    downloads: 76,
    opens: 54,
    spec: {
      kind: "whiteboard",
      title: "Retrospektive",
      summary: { de: "Gut, schlecht, Ideen: drei Spalten für die Sprint-Retro auf dem Whiteboard.", en: "Good, bad, ideas: three columns for your sprint retro on the whiteboard." },
      category: "meetings",
      tags: ["retro", "agile"],
      language: "de",
      payload: [
        whiteboardPayload("Retrospektive", [
          { id: "t1", type: "text", x: 0, y: 0, w: 200, h: 40, text: "Was lief gut?" },
          { id: "t2", type: "text", x: 260, y: 0, w: 200, h: 40, text: "Was lief schlecht?" },
          { id: "t3", type: "text", x: 520, y: 0, w: 200, h: 40, text: "Ideen" },
          { id: "s1", type: "sticky", x: 0, y: 60, w: 200, h: 120, text: "", fill: "#ffe58a" },
        ]),
      ],
      previews: [previewImage("whiteboard", ACCENT, 0)],
    },
  },
  {
    author: "mei",
    status: "published",
    downloads: 233,
    opens: 190,
    spec: {
      kind: "appearance",
      title: "Tannengrün",
      summary: { de: "Ruhiges Tannengrün als Akzent – angenehm in Hell und Dunkel.", en: "Calm fir green as the accent – easy on the eyes in light and dark." },
      category: "other",
      tags: ["theme", "grün"],
      language: "multi",
      payload: [appearancePayload({ accent: "#2f6f5e" })],
      previews: [previewImage("appearance", "#2f6f5e", 0)],
    },
  },
  {
    author: "jonas",
    status: "published",
    downloads: 64,
    opens: 40,
    spec: {
      kind: "link-rules",
      title: "GitHub issues & tickets",
      summary: { de: "Macht aus #123 und JIRA-42 automatisch Links zu GitHub und Jira.", en: "Turns #123 and JIRA-42 into links to GitHub and Jira automatically." },
      category: "knowledge",
      tags: ["github", "jira", "links"],
      language: "multi",
      payload: [
        linkRulesPayload([
          { name: "GitHub issue", pattern: "#(\\d+)", template: "https://github.com/your-org/your-repo/issues/$1" },
          { name: "Jira ticket", pattern: "\\b(JIRA-\\d+)\\b", template: "https://your-company.atlassian.net/browse/$1" },
        ]),
      ],
      previews: [previewImage("link-rules", ACCENT, 0)],
    },
  },
  {
    author: "demo",
    status: "submitted",
    spec: {
      kind: "workflow",
      title: "Wochenbericht per E-Mail",
      summary: { de: "Jeden Freitag eine E-Mail mit allen erledigten Aufgaben der Woche.", en: "Every Friday an e-mail with all tasks done this week." },
      category: "planning",
      tags: ["bericht", "e-mail"],
      language: "de",
      payload: [
        workflowPayload(
          "Wochenbericht",
          [
            { id: "n_sched01", type: "trigger.schedule", label: "Freitags 16 Uhr", x: 0, y: 0, config: { cron: "0 16 * * 5" } },
            { id: "n_find001", type: "action.record.find", label: "Erledigte Aufgaben", x: 280, y: 0 },
            { id: "n_mail001", type: "notify.email", label: "Bericht senden", x: 560, y: 0, config: { to: ["@runner"], subject: "Wochenbericht" } },
          ],
          [
            ["n_sched01", "n_find001"],
            ["n_find001", "n_mail001"],
          ],
        ),
      ],
      previews: [previewImage("workflow", ACCENT, 1)],
    },
  },
  {
    author: "mei",
    status: "changes_requested",
    message: "Danke! Bitte ergänze noch eine englische Kurzbeschreibung und ein Vorschaubild.",
    spec: {
      kind: "document",
      title: "OKR-Planung",
      summary: { de: "Ziele und Schlüsselergebnisse für das Quartal festhalten." },
      category: "planning",
      tags: ["okr", "ziele"],
      language: "de",
      payload: [documentPayload("OKR-Planung", "planning", "<h1>OKRs</h1><h2>Ziel 1</h2><ul><li><p>Schlüsselergebnis</p></li></ul>")],
    },
  },
];

export async function seedDemo() {
  // Official templates (lib/official.ts) don't count: the demo comes on top.
  if (one("SELECT 1 FROM templates t JOIN users u ON u.id=t.author_id WHERE u.system=0 LIMIT 1")) return false;
  const authors: Record<Demo["author"], User> = {
    demo: one<User>("SELECT * FROM users WHERE handle='demo'") ?? createUser({ name: "Demo-Autorin", email: "demo@example.org", handle: "demo" }),
    jonas: createUser({ name: "Jonas Weber", githubId: "1000001", githubLogin: "jonasweber" }),
    mei: createUser({ name: "Mei Lin", email: "mei@example.org", handle: "mei" }),
  };
  const published: string[] = [];
  let day = 40;
  for (const d of demos()) {
    const s = d.spec;
    const result = await submit(authors[d.author], buildSamplePackage(s), {
      title: s.title,
      summaryDe: s.summary.de ?? "",
      summaryEn: s.summary.en ?? "",
      descriptionDe: s.description?.de ?? "",
      descriptionEn: s.description?.en ?? "",
      category: s.category,
      tags: s.tags ?? [],
      language: s.language ?? "de",
      minVersion: s.minVersion ?? "0.9.4",
      license: d.author === "jonas" ? "MIT" : "CC-BY-4.0",
      rights: true,
      changelog: "",
    });
    const at = Date.now() - day-- * 86_400_000 * 0.8;
    run("UPDATE versions SET submitted_at=?,updated_at=? WHERE id=?", at, at, result.versionId);
    if (d.status === "published") {
      await decide(result.versionId, { decision: "publish", message: "" }, "demo-seed");
      run("UPDATE versions SET published_at=?,decided_at=? WHERE id=?", at + 3_600_000, at + 3_600_000, result.versionId);
      run("UPDATE templates SET published_at=?,downloads=?,opens=? WHERE id=?", at + 3_600_000, d.downloads ?? 0, d.opens ?? 0, result.templateId);
      published.push(result.templateId);
    } else if (d.status === "changes_requested") await decide(result.versionId, { decision: "request_changes", message: d.message ?? "Bitte überarbeiten." }, "demo-seed");
  }
  setFeatured({ templates: [published[2], published[0], published[4]] }, "demo-seed");
  createReport({ slug: "project-brief", reason: "broken", text: "Der Link im Text führt ins Leere." }, "198.51.100.7");
  return true;
}
