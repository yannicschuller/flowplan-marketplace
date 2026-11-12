// "Was er macht" and "Nach dem Import legst du fest" of a workflow
// (lib/workflow-view.ts): plain text from the graph, no markup from the
// package. Works on the server (template page) and in the submit form.
import type { T } from "@/lib/i18n";
import type { WorkflowView } from "@/lib/workflow-view";

export function WorkflowSummary({ view, t }: { view: WorkflowView; t: T }) {
  const steps = view.nodes.filter((n) => n.step !== null);
  return (
    <div className="wf-summary">
      <h3>{t("Was er macht", "What it does")}</h3>
      <p>{view.summary.lead}</p>
      {view.summary.steps.length > 0 && (
        <ol>
          {view.summary.steps.map((s, i) => (
            <li key={steps[i]?.id ?? i} value={steps[i]?.step ?? i + 1}>
              {s}
            </li>
          ))}
        </ol>
      )}
      {view.summary.notes.map((n, i) => (
        <p key={i} className="muted">
          {n}
        </p>
      ))}
      {view.gaps.length > 0 && (
        <>
          <h3>{t("Nach dem Import legst du fest:", "After the import you set:")}</h3>
          <ul className="wf-gaps">
            {view.gaps.map((g, i) => (
              <li key={i}>{g}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
