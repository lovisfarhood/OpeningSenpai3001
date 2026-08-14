import {
  isEndOfLine,
  maximumTrainingDepth,
  practiceBranches,
  remainingLineCount,
  storedContinuations,
  type VariationIndex,
} from '../domain/variations.js';

export function VariationSummary({
  index,
  position,
  showMaximumDepth = false,
  remainingPracticeItems,
  fullTheoryLines,
}: {
  index: VariationIndex;
  position: string;
  showMaximumDepth?: boolean;
  remainingPracticeItems?: number;
  fullTheoryLines?: number;
}) {
  const storedCount = storedContinuations(index, position).length;
  const branchCount = practiceBranches(index, position).length;
  const lineCount = remainingLineCount(index, position);

  return (
    <section className="variation-summary" aria-label="Variation Summary">
      <div className="variation-summary-heading">
        <p className="eyebrow">Variation Summary</p>
        {isEndOfLine(index, position) ? (
          <strong className="end-of-line" role="status">
            End of line
          </strong>
        ) : null}
      </div>
      <dl>
        <div>
          <dt>Stored continuations</dt>
          <dd>{storedCount}</dd>
        </div>
        <div>
          <dt>Practice branches</dt>
          <dd>{branchCount}</dd>
        </div>
        <div>
          <dt>Remaining lines</dt>
          <dd>{remainingPracticeItems ?? lineCount}</dd>
        </div>
        {fullTheoryLines !== undefined ? <div>
          <dt>Full theory lines</dt>
          <dd>{fullTheoryLines}</dd>
        </div> : null}
        {showMaximumDepth ? (
          <div>
            <dt>Maximum training depth</dt>
            <dd>{maximumTrainingDepth(index, position)}</dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}

export function StoredContinuations({
  index,
  position,
}: {
  index: VariationIndex;
  position: string;
}) {
  const continuations = storedContinuations(index, position);
  return (
    <section
      className="stored-continuations"
      aria-label="Stored continuations"
    >
      <h2>Stored continuations: {continuations.length}</h2>
      {continuations.length > 0 ? (
        <ul>
          {continuations.map((continuation) => (
            <li key={continuation.id}>
              <span>{continuation.san}</span>
              {continuation.pathCount > 1 ? (
                <small>{continuation.pathCount} paths</small>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty-copy">No stored continuation from this position.</p>
      )}
    </section>
  );
}

export function ArrowLegend({
  course = false,
  stored = false,
  hint = false,
  explorerRoles = false,
}: {
  course?: boolean;
  stored?: boolean;
  hint?: boolean;
  explorerRoles?: boolean;
}) {
  return (
    <div className="arrow-legend" aria-label="Board arrow legend">
      {course ? (
        <span><i className="legend-course" />Course strategy</span>
      ) : null}
      {stored ? (
        <span><i className="legend-stored" />Stored variation</span>
      ) : null}
      {hint ? (
        <span><i className="legend-hint" />Practice hint</span>
      ) : null}
      {explorerRoles ? <>
        <span><i className="legend-repertoire" />Repertoire move</span>
        <span><i className="legend-opponent" />Opponent move</span>
        <span><i className="legend-both" />Both roles</span>
      </> : null}
    </div>
  );
}
