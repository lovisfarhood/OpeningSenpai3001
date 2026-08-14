import { describe, expect, it } from 'vitest';

import { buildCanonicalRepertoire } from '../../scripts/lib/build.js';
import {
  restoreNavigationState,
  toNavigationState,
} from '../../src/domain/navigation.js';
import {
  createInitialSession,
  playPendingBlackReply,
  playWhiteMove,
  undoFullMove,
  type LocalBranch,
} from '../../src/domain/session.js';
import { normalizeFen } from '../../src/domain/repertoire.js';
import {
  createFixtureStudy,
  createLoadedSources,
  linePositions,
} from '../fixtures/repertoire-fixture.js';

describe('persistierte Navigation', () => {
  it('stellt aktuelle Stellung und Vorwärtshistorie nach einem Reload wieder her', () => {
    const repertoire = buildCanonicalRepertoire(
      createLoadedSources([
        createFixtureStudy({
          studyFolder: 'main',
          lines: [{ sans: ['e4', 'c6', 'd4', 'd5'] }],
        }),
      ]),
    ).repertoire;
    let session = createInitialSession();
    session = playPendingBlackReply(
      playWhiteMove(session, { from: 'e2', to: 'e4' }, repertoire).state,
      repertoire,
    );
    session = playPendingBlackReply(
      playWhiteMove(session, { from: 'd2', to: 'd4' }, repertoire).state,
      repertoire,
    );
    const atFirstTurn = undoFullMove(session);

    const restored = restoreNavigationState(
      toNavigationState(atFirstTurn, '2026-07-24T00:00:00.000Z'),
      repertoire,
      {},
      [],
    );

    expect(restored.fullFen).toBe(atFirstTurn.fullFen);
    expect(restored.historyIndex).toBe(1);
    expect(restored.history).toHaveLength(2);
  });

  it('stellt eine persistierte lokale Kandidatenauswahl auch neben einer Basisoption wieder her', () => {
    const repertoire = buildCanonicalRepertoire(
      createLoadedSources([
        createFixtureStudy({
          studyFolder: 'main',
          lines: [{ sans: ['e4', 'c6'] }],
        }),
      ]),
    ).repertoire;
    const bonusPositions = linePositions(['e4', 'c5']);
    const resultingPosition = bonusPositions[2];
    if (!resultingPosition) {
      throw new Error('Fixture-FEN fehlt.');
    }
    const localBranch: LocalBranch = {
      id: 'bonus-c5',
      sourceType: 'bonus',
      startPosition: repertoire.rootPosition,
      whiteSan: 'e4',
      blackSan: 'c5',
      resultingPosition: normalizeFen(resultingPosition),
      explanation: 'Bonus-Erklärung',
      plans: 'Bonus-Plan',
    };
    const decision = repertoire.whiteTurnNodes[repertoire.rootPosition]?.moves
      .find((move) => move.san === 'e4');
    if (!decision) {
      throw new Error('Fixture-Entscheidung fehlt.');
    }
    const completed = playPendingBlackReply(
      playWhiteMove(
        createInitialSession(),
        { from: 'e2', to: 'e4' },
        repertoire,
        { [decision.id]: localBranch.id },
        [localBranch],
      ).state,
      repertoire,
    );

    const restored = restoreNavigationState(
      toNavigationState(completed, '2026-07-24T00:00:00.000Z'),
      repertoire,
      {},
      [localBranch],
    );

    expect(restored.historyIndex).toBe(1);
    expect(restored.currentPosition).toBe(localBranch.resultingPosition);
    expect(restored.response).toMatchObject({
      blackSan: 'c5',
      candidateId: localBranch.id,
      manual: true,
    });
  });
});
