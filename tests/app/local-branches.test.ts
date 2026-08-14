import { describe, expect, it } from 'vitest';

import { localAdditionsToBranches } from '../../src/domain/local-branches.js';
import type { LocalAddition } from '../../src/storage/types.js';

describe('importierte lokale Zweige', () => {
  it('hält Antwort- und Ergebnis-Markierungen beim App-Mapping getrennt', () => {
    const addition: LocalAddition = {
      id: 'imported-addition',
      sourceType: 'bonus',
      branchId: 'imported-branch',
      baseDecisionId: 'decision-e4',
      whiteTurnPosition: 'white-position',
      whiteMoveSan: 'e4',
      blackTurnPosition: 'black-position',
      replies: [
        {
          id: 'imported-c5',
          san: 'c5',
          resultingWhiteTurnPosition: 'result-position',
          replyExplanation: {
            text: 'Antworterklärung',
            arrows: {
              threats: ['c7-c5'],
              opportunities: ['d8-a5'],
            },
            highlights: {
              threats: ['d4'],
              opportunities: ['c5'],
            },
          },
          resultingPlan: {
            text: 'Ergebnisplan',
            arrows: {
              threats: ['c5-c4'],
              opportunities: ['g8-f6'],
            },
            highlights: {
              threats: ['b2'],
              opportunities: ['d4'],
            },
          },
        },
      ],
      createdAt: '2026-07-24T00:00:00.000Z',
      updatedAt: '2026-07-24T00:00:00.000Z',
    };

    expect(localAdditionsToBranches([addition])).toEqual([
      {
        id: 'imported-c5',
        sourceType: 'bonus',
        startPosition: 'white-position',
        whiteSan: 'e4',
        blackSan: 'c5',
        resultingPosition: 'result-position',
        explanation: 'Antworterklärung',
        plans: 'Ergebnisplan',
        replyArrows: {
          threats: ['c7-c5'],
          opportunities: ['d8-a5'],
        },
        replyHighlights: {
          threats: ['d4'],
          opportunities: ['c5'],
        },
        resultingArrows: {
          threats: ['c5-c4'],
          opportunities: ['g8-f6'],
        },
        resultingHighlights: {
          threats: ['b2'],
          opportunities: ['d4'],
        },
      },
    ]);
  });
});
