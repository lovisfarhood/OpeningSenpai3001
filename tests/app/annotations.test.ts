import { describe, expect, it } from 'vitest';

import { buildCanonicalRepertoire } from '../../scripts/lib/build.js';
import { annotationsAfterEdge } from '../../src/domain/annotations.js';
import {
  createExplorerIndex,
  explorerAnnotationsAfterMove,
  explorerPosition,
  type ExplorerSource,
} from '../../src/domain/explorer.js';
import type { CanonicalRepertoire } from '../../src/domain/repertoire.js';
import {
  createFixtureStudy,
  createLoadedSources,
  linePositions,
} from '../fixtures/repertoire-fixture.js';

function repertoireWithComments(
  id: string,
  studies: ReturnType<typeof createFixtureStudy>[],
): CanonicalRepertoire {
  return buildCanonicalRepertoire(createLoadedSources(studies), {
    openingId: id,
    title: id,
    repertoireSide: 'white',
  }).repertoire;
}

function source(repertoire: CanonicalRepertoire): ExplorerSource {
  return {
    openingId: repertoire.openingId,
    title: repertoire.title,
    repertoireSide: repertoire.openingSide,
    repertoire,
  };
}

describe('move-bound annotations', () => {
  it('shows no future comment at the root and reveals only the reached move annotation', () => {
    const positions = linePositions(['e4', 'e5', 'Nf3']);
    const repertoire = repertoireWithComments('timing', [createFixtureStudy({
      studyFolder: 'timing-study',
      lines: [{ sans: ['e4', 'e5', 'Nf3'] }],
      comments: [
        { fen: positions[0]!, comment: { text: 'Play e4.', arrows: null, highlights: null } },
        { fen: positions[2]!, comment: { text: 'Now play Nf3.', arrows: null, highlights: null } },
      ],
    })]);
    const e4 = Object.values(repertoire.edges).find((edge) => edge.san === 'e4');

    expect(annotationsAfterEdge(repertoire, null)).toEqual([]);
    expect(annotationsAfterEdge(repertoire, e4).map((item) => item.text)).toEqual(['Play e4.']);
    expect(annotationsAfterEdge(repertoire, e4).map((item) => item.text)).not.toContain('Now play Nf3.');
  });

  it('deduplicates identical text and aggregates its source studies', () => {
    const positions = linePositions(['e4', 'e5']);
    const comment = { text: 'Control the center.', arrows: null, highlights: null };
    const repertoire = repertoireWithComments('sources', [
      createFixtureStudy({ studyFolder: 'study-a', lines: [{ sans: ['e4', 'e5'] }], comments: [{ fen: positions[0]!, comment }] }),
      createFixtureStudy({ studyFolder: 'study-b', lines: [{ sans: ['e4', 'e5'] }], comments: [{ fen: positions[0]!, comment }] }),
    ]);
    const e4 = Object.values(repertoire.edges).find((edge) => edge.san === 'e4');
    const annotations = annotationsAfterEdge(repertoire, e4);

    expect(annotations).toHaveLength(1);
    expect(annotations[0]?.sources.map((item) => item.study).sort()).toEqual(['study-a', 'study-b']);
  });

  it('aggregates equal comments across Explorer source openings after the move', () => {
    const positions = linePositions(['e4', 'e5']);
    const make = (id: string) => repertoireWithComments(id, [createFixtureStudy({
      studyFolder: `${id}-study`,
      lines: [{ sans: ['e4', 'e5'] }],
      comments: [{ fen: positions[0]!, comment: { text: 'Shared idea.', arrows: null, highlights: null } }],
    })]);
    const first = make('first');
    const second = make('second');
    const index = createExplorerIndex([source(first), source(second)]);
    const move = explorerPosition(index, first.positions[first.rootPosition]!.fullFens[0]!).moves.find((item) => item.san === 'e4');
    const annotations = explorerAnnotationsAfterMove(index, move);

    expect(annotations).toHaveLength(1);
    expect(annotations[0]?.openings).toEqual(['first', 'second']);
    expect(annotations[0]?.studies).toEqual(['first-study', 'second-study']);
  });
});

