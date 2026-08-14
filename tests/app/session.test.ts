import { describe, expect, it } from 'vitest';

import { buildCanonicalRepertoire } from '../../scripts/lib/build.js';
import {
  addManualReply,
  choosePendingCandidate,
  choosePendingLocalBranch,
  createInitialSession,
  forwardFullMove,
  playPendingBlackReply,
  playWhiteMove,
  restartSession,
  undoFullMove,
  type LocalBranch,
} from '../../src/domain/session.js';
import { normalizeFen } from '../../src/domain/repertoire.js';
import {
  createFixtureStudy,
  createLoadedSources,
  linePositions,
} from '../fixtures/repertoire-fixture.js';

function repertoire(...studies: ReturnType<typeof createFixtureStudy>[]) {
  return buildCanonicalRepertoire(createLoadedSources(studies)).repertoire;
}

function localReply(
  data: ReturnType<typeof repertoire>,
  sourceType: LocalBranch['sourceType'],
  blackSan: 'c5' | 'c6',
  id = `${sourceType}-${blackSan}`,
): LocalBranch {
  const positions = linePositions(['e4', blackSan]);
  const resultingPosition = positions[2];
  if (!resultingPosition) {
    throw new Error('Fixture-FEN fehlt.');
  }
  return {
    id,
    sourceType,
    startPosition: data.rootPosition,
    whiteSan: 'e4',
    blackSan,
    resultingPosition: normalizeFen(resultingPosition),
    explanation: `${sourceType} explanation`,
    plans: `${sourceType} plan`,
  };
}

describe('App-Sitzungslogik', () => {
  it('spielt die ausgewählte schwarze Antwort automatisch', () => {
    const data = repertoire(
      createFixtureStudy({
        studyFolder: 'main',
        lines: [{ sans: ['e4', 'c6', 'd4', 'd5'] }],
      }),
    );
    const white = playWhiteMove(
      createInitialSession(),
      { from: 'e2', to: 'e4' },
      data,
    );

    expect(white.accepted).toBe(true);
    expect(white.state.status).toBe('waiting');

    const afterReply = playPendingBlackReply(white.state, data);
    expect(afterReply.status).toBe('ready');
    expect(afterReply.response?.blackSan).toBe('c6');
    expect(afterReply.history).toHaveLength(1);
  });

  it('spielt auf einen unbekannten weißen Zug keine schwarze Antwort', () => {
    const data = repertoire(
      createFixtureStudy({
        studyFolder: 'main',
        lines: [{ sans: ['e4', 'c6'] }],
      }),
    );
    const white = playWhiteMove(
      createInitialSession(),
      { from: 'd2', to: 'd4' },
      data,
    );

    expect(white.accepted).toBe(true);
    expect(white.state.status).toBe('unknown');
    expect(playPendingBlackReply(white.state, data)).toEqual(white.state);
    expect(white.state.message).toBe(
      'Dieser weiße Zug ist noch nicht im Repertoire enthalten.',
    );
  });

  it('wartet bei einem ungelösten Konflikt auf eine bewusste Auswahl', () => {
    const data = repertoire(
      createFixtureStudy({
        studyFolder: 'c6',
        lines: [{ sans: ['e4', 'c6'] }],
      }),
      createFixtureStudy({
        studyFolder: 'c5',
        lines: [{ sans: ['e4', 'c5'] }],
      }),
    );
    const white = playWhiteMove(
      createInitialSession(),
      { from: 'e2', to: 'e4' },
      data,
    );

    expect(white.state.status).toBe('conflict');
    expect(playPendingBlackReply(white.state, data)).toEqual(white.state);

    const candidate = white.state.pending?.option?.candidates.find(
      (item) => item.san === 'c6',
    );
    const selected = choosePendingCandidate(
      white.state,
      candidate?.id ?? 'missing',
    );
    expect(playPendingBlackReply(selected, data).response?.blackSan).toBe('c6');
  });

  it('verwendet eine gespeicherte lokale Standardantwort', () => {
    const data = repertoire(
      createFixtureStudy({
        studyFolder: 'c6',
        lines: [{ sans: ['e4', 'c6'] }],
      }),
      createFixtureStudy({
        studyFolder: 'c5',
        lines: [{ sans: ['e4', 'c5'] }],
      }),
    );
    const option = data.whiteTurnNodes[data.rootPosition]?.moves[0];
    const c5 = option?.candidates.find((candidate) => candidate.san === 'c5');
    const white = playWhiteMove(
      createInitialSession(),
      { from: 'e2', to: 'e4' },
      data,
      option && c5 ? { [option.id]: c5.id } : {},
    );

    expect(white.state.status).toBe('waiting');
    expect(playPendingBlackReply(white.state, data).response?.blackSan).toBe('c5');
  });

  it('behält Main gegenüber einer Bonusabweichung als Standard und bietet Bonus als Alternative an', () => {
    const data = repertoire(
      createFixtureStudy({
        studyFolder: 'main-c6',
        lines: [{ sans: ['e4', 'c6'] }],
      }),
    );
    const bonus = localReply(data, 'bonus', 'c5');
    const white = playWhiteMove(
      createInitialSession(),
      { from: 'e2', to: 'e4' },
      data,
      {},
      [bonus],
    );

    expect(white.state.status).toBe('waiting');
    expect(white.state.pending?.candidateId).not.toBeNull();
    expect(white.state.pending?.localBranches).toEqual([bonus]);
    expect(playPendingBlackReply(white.state, data).response?.blackSan).toBe(
      'c6',
    );

    const selectedBonus = choosePendingLocalBranch(white.state, bonus.id);
    expect(
      playPendingBlackReply(selectedBonus, data).response,
    ).toMatchObject({
      blackSan: 'c5',
      candidateId: bonus.id,
      manual: true,
    });
  });

  it('lässt eine abweichende Main-Importantwort als ungelösten Konflikt stehen', () => {
    const data = repertoire(
      createFixtureStudy({
        studyFolder: 'main-c6',
        lines: [{ sans: ['e4', 'c6'] }],
      }),
    );
    const importedMain = localReply(data, 'main', 'c5');
    const white = playWhiteMove(
      createInitialSession(),
      { from: 'e2', to: 'e4' },
      data,
      {},
      [importedMain],
    );

    expect(white.state.status).toBe('conflict');
    expect(white.state.pending?.candidateId).toBeNull();
    expect(playPendingBlackReply(white.state, data)).toEqual(white.state);
  });

  it('priorisiert genau eine lokale User-Antwort gegenüber Main', () => {
    const data = repertoire(
      createFixtureStudy({
        studyFolder: 'main-c6',
        lines: [{ sans: ['e4', 'c6'] }],
      }),
    );
    const userReply = localReply(data, 'user', 'c5');
    const white = playWhiteMove(
      createInitialSession(),
      { from: 'e2', to: 'e4' },
      data,
      {},
      [userReply],
    );

    expect(white.state.status).toBe('waiting');
    expect(white.state.pending?.localBranch).toEqual(userReply);
    expect(playPendingBlackReply(white.state, data).response).toMatchObject({
      blackSan: 'c5',
      candidateId: userReply.id,
      manual: true,
    });
  });

  it('nimmt einen vollständigen Zug zurück und navigiert wieder vorwärts', () => {
    const data = repertoire(
      createFixtureStudy({
        studyFolder: 'main',
        lines: [{ sans: ['e4', 'c6', 'd4', 'd5'] }],
      }),
    );
    const initial = createInitialSession();
    const first = playPendingBlackReply(
      playWhiteMove(initial, { from: 'e2', to: 'e4' }, data).state,
      data,
    );
    const second = playPendingBlackReply(
      playWhiteMove(first, { from: 'd2', to: 'd4' }, data).state,
      data,
    );

    const undone = undoFullMove(second);
    expect(undone.historyIndex).toBe(1);
    expect(undone.fullFen).toBe(first.fullFen);

    const forwarded = forwardFullMove(undone);
    expect(forwarded.historyIndex).toBe(2);
    expect(forwarded.fullFen).toBe(second.fullFen);
  });

  it('nimmt auch einen noch unbeantworteten weißen Zug vollständig zurück', () => {
    const data = repertoire(
      createFixtureStudy({
        studyFolder: 'main',
        lines: [{ sans: ['e4', 'c6'] }],
      }),
    );
    const initial = createInitialSession();
    const unknown = playWhiteMove(
      initial,
      { from: 'd2', to: 'd4' },
      data,
    ).state;

    expect(undoFullMove(unknown)).toEqual(initial);
  });

  it('ergänzt einen unbekannten Ast lokal ohne die Basis zu verändern', () => {
    const data = repertoire(
      createFixtureStudy({
        studyFolder: 'main',
        lines: [{ sans: ['e4', 'c6'] }],
      }),
    );
    const unknown = playWhiteMove(
      createInitialSession(),
      { from: 'd2', to: 'd4' },
      data,
    ).state;
    const completed = addManualReply(unknown, 'd5', 'Lokale Erklärung', 'Plan');

    expect(completed.branch).toMatchObject({
      whiteSan: 'd4',
      blackSan: 'd5',
      explanation: 'Lokale Erklärung',
      plans: 'Plan',
    });
    expect(completed.state.response).toMatchObject({
      manual: true,
      candidateId: completed.branch?.id,
      decisionId: expect.stringMatching(/^local-decision_/),
    });
    expect(data.summary.activeWhiteDecisions).toBe(1);
  });

  it('setzt die Sitzung vollständig neu auf', () => {
    expect(restartSession()).toEqual(createInitialSession());
  });
});
