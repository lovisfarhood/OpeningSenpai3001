// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { StrategicIdeas } from './BookContent';

afterEach(cleanup);

describe('StrategicIdeas', () => {
  it('zeigt importierte Antwort- und Ergebnis-Markierungen getrennt', () => {
    render(
      <StrategicIdeas
        currentAnnotations={[]}
        previousAnnotations={[]}
        arrowOverride={{
          threats: ['c5-c4'],
          opportunities: ['g8-f6'],
        }}
        highlightOverride={{
          threats: ['b2'],
          opportunities: ['d4'],
        }}
        previousArrowOverride={{
          threats: ['c7-c5'],
          opportunities: ['d8-a5'],
        }}
        previousHighlightOverride={{
          threats: ['e4'],
          opportunities: ['c5'],
        }}
      />,
    );

    for (const coordinate of [
      'c5-c4',
      'g8-f6',
      'b2',
      'd4',
      'c7-c5',
      'd8-a5',
      'e4',
      'c5',
    ]) {
      expect(screen.getByText(coordinate)).toBeDefined();
    }
    expect(
      screen.getByText('Hinweise zur Stellung vor der schwarzen Antwort'),
    ).toBeDefined();
  });
});
