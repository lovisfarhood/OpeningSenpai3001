import type {
  AnnotationMarks,
  CanonicalAnnotation,
} from '../domain/repertoire.js';

interface AnnotationSectionProps {
  eyebrow: string;
  title: string;
  annotations: CanonicalAnnotation[];
  overrideText?: string | null | undefined;
  emptyText: string;
}

function sourceLabel(annotation: CanonicalAnnotation): string {
  return [
    ...new Set(annotation.sources.map((source) => source.studyFolder)),
  ].join(', ');
}

function sortedAnnotations(
  annotations: CanonicalAnnotation[],
): CanonicalAnnotation[] {
  return [...annotations].sort((left, right) => {
    const leftStudy = left.sources[0]?.studyFolder ?? '';
    const rightStudy = right.sources[0]?.studyFolder ?? '';
    return (
      leftStudy.localeCompare(rightStudy, 'en') ||
      left.id.localeCompare(right.id, 'en')
    );
  });
}

function TextBlock({
  annotation,
  compact = false,
}: {
  annotation: CanonicalAnnotation;
  compact?: boolean;
}) {
  return (
    <article className={compact ? 'annotation-note compact' : 'annotation-note'}>
      <p>{annotation.text}</p>
      <span className="source-label">{sourceLabel(annotation)}</span>
    </article>
  );
}

export function AnnotationSection({
  eyebrow,
  title,
  annotations,
  overrideText,
  emptyText,
}: AnnotationSectionProps) {
  const ordered = sortedAnnotations(annotations);
  return (
    <section className="book-section">
      <p className="eyebrow">{eyebrow}</p>
      <h2>{title}</h2>
      {overrideText !== undefined ? (
        overrideText ? (
          <article className="annotation-note local-note">
            <p>{overrideText}</p>
            <span className="source-label">Lokale Bearbeitung</span>
          </article>
        ) : (
          <p className="empty-copy">{emptyText}</p>
        )
      ) : ordered[0] ? (
        <>
          <TextBlock annotation={ordered[0]} />
          {ordered.length > 1 ? (
            <details className="more-notes">
              <summary>
                {ordered.length - 1} weitere Chessly-Notiz
                {ordered.length - 1 === 1 ? '' : 'en'}
              </summary>
              <div className="more-notes-list">
                {ordered.slice(1).map((annotation) => (
                  <TextBlock
                    key={annotation.id}
                    annotation={annotation}
                    compact
                  />
                ))}
              </div>
            </details>
          ) : null}
        </>
      ) : (
        <p className="empty-copy">{emptyText}</p>
      )}
    </section>
  );
}

function mergeMarks(
  annotations: CanonicalAnnotation[],
  field: 'arrows' | 'highlights',
  override?: AnnotationMarks | null,
): AnnotationMarks {
  if (override !== undefined) {
    return override ?? { threats: [], opportunities: [] };
  }
  const threats = new Set<string>();
  const opportunities = new Set<string>();
  for (const annotation of annotations) {
    for (const value of annotation[field]?.threats ?? []) {
      threats.add(value);
    }
    for (const value of annotation[field]?.opportunities ?? []) {
      opportunities.add(value);
    }
  }
  return {
    threats: [...threats].sort(),
    opportunities: [...opportunities].sort(),
  };
}

function CoordinateGroup({
  label,
  values,
  tone,
}: {
  label: string;
  values: string[];
  tone: 'threat' | 'opportunity';
}) {
  if (values.length === 0) {
    return null;
  }
  return (
    <div className="coordinate-group">
      <h4>{label}</h4>
      <div className="coordinate-list">
        {values.map((value) => (
          <code className={`coordinate ${tone}`} key={`${tone}-${value}`}>
            {value}
          </code>
        ))}
      </div>
    </div>
  );
}

export function StrategicIdeas({
  currentAnnotations,
  previousAnnotations,
  arrowOverride,
  highlightOverride,
  previousArrowOverride,
  previousHighlightOverride,
}: {
  currentAnnotations: CanonicalAnnotation[];
  previousAnnotations: CanonicalAnnotation[];
  arrowOverride?: AnnotationMarks | null | undefined;
  highlightOverride?: AnnotationMarks | null | undefined;
  previousArrowOverride?: AnnotationMarks | null | undefined;
  previousHighlightOverride?: AnnotationMarks | null | undefined;
}) {
  const currentArrows = mergeMarks(
    currentAnnotations,
    'arrows',
    arrowOverride,
  );
  const currentHighlights = mergeMarks(
    currentAnnotations,
    'highlights',
    highlightOverride,
  );
  const previousArrows = mergeMarks(
    previousAnnotations,
    'arrows',
    previousArrowOverride,
  );
  const previousHighlights = mergeMarks(
    previousAnnotations,
    'highlights',
    previousHighlightOverride,
  );
  const hasCurrent =
    currentArrows.threats.length +
      currentArrows.opportunities.length +
      currentHighlights.threats.length +
      currentHighlights.opportunities.length >
    0;
  const hasPrevious =
    previousArrows.threats.length +
      previousArrows.opportunities.length +
      previousHighlights.threats.length +
      previousHighlights.opportunities.length >
    0;

  return (
    <section className="book-section strategic-section">
      <p className="eyebrow">Aus den Rohdaten</p>
      <h2>Strategische Ideen</h2>
      {hasCurrent ? (
        <div className="idea-grid">
          <CoordinateGroup
            label="Chancen · Pfeile"
            values={currentArrows.opportunities}
            tone="opportunity"
          />
          <CoordinateGroup
            label="Drohungen · Pfeile"
            values={currentArrows.threats}
            tone="threat"
          />
          <CoordinateGroup
            label="Chancen · Felder"
            values={currentHighlights.opportunities}
            tone="opportunity"
          />
          <CoordinateGroup
            label="Drohungen · Felder"
            values={currentHighlights.threats}
            tone="threat"
          />
        </div>
      ) : (
        <p className="empty-copy">
          Für die aktuelle Endstellung sind keine Pfeile oder Highlights
          gespeichert.
        </p>
      )}
      {hasPrevious ? (
        <details className="previous-position-hints">
          <summary>Hinweise zur Stellung vor der schwarzen Antwort</summary>
          <p>
            Diese Markierungen gehören zur vorherigen Schwarz-am-Zug-Stellung
            und werden deshalb nicht auf das aktuelle Brett verschoben.
          </p>
          <div className="idea-grid">
            <CoordinateGroup
              label="Chancen · Pfeile"
              values={previousArrows.opportunities}
              tone="opportunity"
            />
            <CoordinateGroup
              label="Drohungen · Pfeile"
              values={previousArrows.threats}
              tone="threat"
            />
            <CoordinateGroup
              label="Chancen · Felder"
              values={previousHighlights.opportunities}
              tone="opportunity"
            />
            <CoordinateGroup
              label="Drohungen · Felder"
              values={previousHighlights.threats}
              tone="threat"
            />
          </div>
        </details>
      ) : null}
    </section>
  );
}
