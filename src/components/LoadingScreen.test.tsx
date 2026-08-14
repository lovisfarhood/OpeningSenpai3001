// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { CHESS_FACTS, pickChessFact } from '../content/chess-facts.js';
import { LoadingScreen } from './LoadingScreen.js';

afterEach(cleanup);

describe('LoadingScreen', () => {
  it('uses a sizeable, unique, robust fact collection', () => {
    expect(CHESS_FACTS.length).toBeGreaterThanOrEqual(30);
    expect(new Set(CHESS_FACTS).size).toBe(CHESS_FACTS.length);
    expect(pickChessFact(() => -10)).toBe(CHESS_FACTS[0]);
    expect(pickChessFact(() => 10)).toBe(CHESS_FACTS.at(-1));
  });

  it('shows one fact only while its caller is genuinely loading', () => {
    render(<LoadingScreen message="Loading the opening…"/>);

    expect(screen.getByText('Loading the opening…')).toBeInTheDocument();
    expect(screen.getByLabelText('Chess fact')).toHaveTextContent('While you wait');
    expect(screen.getByRole('main')).toHaveAttribute('aria-busy', 'true');
  });
});
