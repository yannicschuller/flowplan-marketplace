// The sample cards of a flashcard deck (lib/study-meta.ts) on its template
// page and in the submit preview: front and back of each, clozes as gaps
// and marked answers, the options of a multiple choice card, image
// occlusion as the picture with SVG shapes over it. Everything from the
// package is React text or a numeric SVG attribute – never HTML, no style
// attributes (strict CSP); the picture comes from the marketplace's own
// route (only PNG, JPEG or WebP attachments of the template).
import { Fragment, type ReactNode } from "react";
// Types only: lib/study-meta.ts reads ZIPs (server code), this also runs in the browser.
import type { CardType, StudyMask, StudyMeta, StudyRun, StudySample } from "@/lib/study-meta";

const CARD_TYPES: CardType[] = ["basic", "cloze", "typed", "choice", "occlusion"];

type T = (de: string, en: string) => string;

export const cardTypeLabel = (t: T, type: CardType) =>
  ({
    basic: t("Vorder-/Rückseite", "Front and back"),
    cloze: t("Lückentext", "Cloze"),
    typed: t("Antwort eintippen", "Type the answer"),
    choice: t("Multiple Choice", "Multiple choice"),
    occlusion: t("Bildverdeckung", "Image occlusion"),
  })[type];

const lines = (text: string, key: string) =>
  text.split("\n").map((line, i) => (
    <Fragment key={`${key}-${i}`}>
      {i > 0 && <br />}
      {line}
    </Fragment>
  ));

function Runs({ runs, revealed }: { runs: StudyRun[]; revealed: boolean }) {
  return (
    <p className="study-text">
      {runs.map((r, i) =>
        r.gap ? (
          revealed ? (
            <mark key={i} className="study-answer">
              {r.text}
            </mark>
          ) : (
            <span key={i} className="study-gap">
              [{r.text}]
            </span>
          )
        ) : (
          <Fragment key={i}>{lines(r.text, String(i))}</Fragment>
        ),
      )}
    </p>
  );
}

const K = 1000;
const at = (n: number) => Math.round(n * K * 10) / 10;
function Shape({ m, revealed }: { m: StudyMask; revealed: boolean }) {
  const className = `study-mask${m.asked ? " study-mask-asked" : ""}${m.asked && revealed ? " study-mask-revealed" : ""}`;
  if (m.shape === "rect") return <rect className={className} x={at(m.x)} y={at(m.y)} width={at(m.w)} height={at(m.h)} rx={6} />;
  if (m.shape === "ellipse") return <ellipse className={className} cx={at(m.x + m.w / 2)} cy={at(m.y + m.h / 2)} rx={at(m.w / 2)} ry={at(m.h / 2)} />;
  if (m.shape !== "polygon") return null;
  return <polygon className={className} points={m.points.map(([x, y]) => `${at(x)},${at(y)}`).join(" ")} />;
}

function Picture({ sample, src, revealed, t }: { sample: StudySample; src: string | null; revealed: boolean; t: T }) {
  const shapes = (
    <svg className="study-masks" viewBox={`0 0 ${K} ${K}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
      {sample.masks.map((m, i) => (
        <Shape key={i} m={m} revealed={revealed} />
      ))}
    </svg>
  );
  const asked = sample.masks.filter((m) => m.asked && m.label).map((m) => m.label);
  return (
    <figure className="study-figure">
      {src && sample.image ? (
        <div className="study-picture">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={sample.image.alt || t("Bild der Karte", "The card's picture")} loading="lazy" decoding="async" />
          {shapes}
        </div>
      ) : (
        <div className="study-picture study-picture-missing">
          {shapes}
          <span className="study-picture-note">{t("Bild nicht in der Vorschau", "Picture not in the preview")}</span>
        </div>
      )}
      <figcaption className="muted">
        {revealed && asked.length
          ? t(`Antwort: ${asked.join(", ")}`, `Answer: ${asked.join(", ")}`)
          : t(`${sample.masks.length} Bereiche verdeckt, einer ist gefragt`, `${sample.masks.length} areas covered, one is asked`)}
      </figcaption>
    </figure>
  );
}

function Side({ sample, revealed, src, t }: { sample: StudySample; revealed: boolean; src: string | null; t: T }) {
  // A cloze card shows its text on both sides (gaps hidden, then answered).
  const runs = revealed ? sample.back : sample.front;
  const correct = sample.back.map((r) => r.text).join("").trim();
  const parts: ReactNode[] = [];
  if (sample.type === "occlusion") {
    if (!revealed && sample.front.length) parts.push(<Runs key="text" runs={sample.front} revealed={false} />);
    parts.push(<Picture key="picture" sample={sample} src={src} revealed={revealed} t={t} />);
    if (revealed && sample.back.length) parts.push(<Runs key="text" runs={sample.back} revealed />);
  } else if (runs.length) parts.push(<Runs key="text" runs={runs} revealed={revealed} />);
  if (sample.type === "choice" && sample.choices.length)
    parts.push(
      <ul key="choices" className="study-choices">
        {sample.choices.map((c, i) => (
          <li key={i} className={revealed && c === correct ? "is-correct" : undefined}>
            {c}
            {revealed && c === correct && <span className="sr-only"> ({t("richtig", "correct")})</span>}
          </li>
        ))}
      </ul>,
    );
  if (sample.type === "typed" && !revealed) parts.push(<p key="typed" className="study-typed muted">{t("Antwort eintippen …", "Type the answer …")}</p>);
  if (!parts.length) parts.push(<p key="empty" className="muted">–</p>);
  return (
    <div className={`study-side${revealed ? " study-back" : ""}`}>
      <h4 className="study-side-label">{revealed ? t("Rückseite", "Back") : t("Vorderseite", "Front")}</h4>
      {parts}
    </div>
  );
}

export function StudySamples({ meta, imageSrc, t, number }: { meta: StudyMeta; imageSrc: (n: number) => string | null; t: T; number: (n: number) => string }) {
  const types = CARD_TYPES.filter((type) => meta.types[type]);
  return (
    <div className="study-samples">
      <p className="study-counts">
        {t(`${number(meta.cards)} Karten aus ${number(meta.records)} Einträgen`, `${number(meta.cards)} cards from ${number(meta.records)} records`)}
        {meta.reverse ? t(" · auch umgekehrt", " · both ways") : ""}
      </p>
      {types.length > 0 && (
        <ul className="study-types" aria-label={t("Kartentypen", "Card types")}>
          {types.map((type) => (
            <li key={type}>
              {cardTypeLabel(t, type)} <span className="muted">{number(meta.types[type]!)}</span>
            </li>
          ))}
        </ul>
      )}
      {meta.samples.length > 0 && (
        <ol className="study-cards">
          {meta.samples.map((s, i) => (
            <li key={i} className="study-card">
              <span className="study-type">{cardTypeLabel(t, s.type)}</span>
              <div className="study-sides">
                <Side sample={s} revealed={false} src={s.image ? imageSrc(i + 1) : null} t={t} />
                <Side sample={s} revealed src={s.image ? imageSrc(i + 1) : null} t={t} />
              </div>
            </li>
          ))}
        </ol>
      )}
      <p className="note">{t("Lernstände kommen nicht mit: Wer den Stapel übernimmt, beginnt mit neuen Karten.", "Learning progress is not included: whoever takes over the deck starts with new cards.")}</p>
    </div>
  );
}
