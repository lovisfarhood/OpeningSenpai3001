import type {
  LocalAdditionInput,
  NavigationState,
} from '../../src/storage/types.js';

export class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

export function databaseName(label: string): string {
  return `interactive-chessbook-test-${label}-${crypto.randomUUID()}`;
}

export const fixtureAddition: LocalAdditionInput = {
  id: 'addition-e4-c6',
  branchId: 'branch-caro-kann',
  baseDecisionId: null,
  whiteTurnPosition:
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -',
  whiteMoveSan: 'e4',
  blackTurnPosition:
    'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3',
  replies: [
    {
      id: 'local-reply-c6',
      san: 'c6',
      resultingWhiteTurnPosition:
        'rnbqkbnr/pp1ppppp/2p5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -',
      replyExplanation: {
        text: 'Bereitet ...d5 vor.',
        arrows: {
          threats: [],
          opportunities: ['c7-c6'],
        },
        highlights: null,
      },
      resultingPlan: null,
    },
  ],
};

export const fixtureNavigation: NavigationState = {
  currentPosition:
    'rnbqkbnr/pp1ppppp/2p5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -',
  history: [
    {
      whiteTurnPosition:
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -',
      whiteMoveSan: 'e4',
      blackTurnPosition:
        'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3',
      blackMoveSan: 'c6',
      resultingWhiteTurnPosition:
        'rnbqkbnr/pp1ppppp/2p5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -',
      decisionId: 'decision-e4',
      replyCandidateId: 'reply-c6',
    },
  ],
  historyIndex: 0,
  updatedAt: '2026-07-24T15:00:00.000Z',
};
