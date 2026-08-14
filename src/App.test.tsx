// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OpeningIndexEntry } from './data/repertoire.js';
import type { CanonicalRepertoire } from './domain/repertoire.js';

const dataMocks = vi.hoisted(() => ({
  loadOpeningIndex: vi.fn(),
  loadRepertoire: vi.fn(),
}));

vi.mock('./data/repertoire.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./data/repertoire.js')>();
  return {
    ...actual,
    loadOpeningIndex: dataMocks.loadOpeningIndex,
    loadRepertoire: dataMocks.loadRepertoire,
  };
});

vi.mock('./components/OpeningWorkspace.js', () => ({
  OpeningWorkspace: ({
    repertoire,
    initialMode,
  }: {
    repertoire: CanonicalRepertoire;
    initialMode: 'book' | 'practice' | 'explorer';
  }) => (
    <div data-testid="opening-workspace" data-initial-mode={initialMode}>
      {repertoire.title}
    </div>
  ),
}));

import App from './App.js';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const openings: OpeningIndexEntry[] = [
  {
    id: 'caro-kann',
    slug: 'caro-kann-defense',
    title: 'Caro-Kann Defense',
    sourcePath: 'data/chessly/caro-kann',
    sourceCourseUrl: 'https://example.test/courses/caro-kann',
    repertoireSide: 'black',
    chapterCount: 8,
    studyCount: 21,
    positionCount: 1_400,
    moveCount: 2_800,
    commentCount: 700,
    processingStatus: 'ready',
    conflictCount: 0,
    rootFen: 'root',
    processedFile: 'caro-kann.json',
    studies: 21,
    positions: 1_400,
    opponentChoices: 40,
    repertoireDecisions: 39,
    maximumDepth: 18,
    conflicts: 0,
    validationStatus: 'ready',
    issueCount: 0,
    availableModes: ['book', 'practice', 'explorer'],
  },
  {
    id: 'kings-indian',
    slug: 'kings-indian-defense',
    title: "King's Indian Defense",
    sourcePath: 'data/chessly/kings-indian-defense',
    sourceCourseUrl: 'https://example.test/courses/kings-indian',
    repertoireSide: 'black',
    chapterCount: 7,
    studyCount: 11,
    positionCount: 700,
    moveCount: 1_400,
    commentCount: 350,
    processingStatus: 'ready',
    conflictCount: 0,
    rootFen: 'root',
    processedFile: 'kings-indian-defense.json',
    studies: 11,
    positions: 700,
    opponentChoices: 30,
    repertoireDecisions: 29,
    maximumDepth: 14,
    conflicts: 0,
    validationStatus: 'ready',
    issueCount: 0,
    availableModes: ['book'],
  },
  {
    id: 'london-system',
    slug: 'london-system',
    title: 'London System',
    sourcePath: 'data/chessly/london-system',
    sourceCourseUrl: 'https://example.test/courses/london-system',
    repertoireSide: 'white',
    chapterCount: 10,
    studyCount: 25,
    positionCount: 1_200,
    moveCount: 2_400,
    commentCount: 600,
    processingStatus: 'ready',
    conflictCount: 0,
    rootFen: 'root',
    processedFile: 'london-system.json',
    studies: 25,
    positions: 1_200,
    opponentChoices: 35,
    repertoireDecisions: 34,
    maximumDepth: 16,
    conflicts: 0,
    validationStatus: 'ready',
    issueCount: 0,
    availableModes: ['book', 'practice'],
  },
  {
    id: 'reti',
    slug: 'hypermodern-reti',
    title: 'Réti Opening',
    sourcePath: 'data/chessly/reti',
    sourceCourseUrl: 'https://example.test/courses/reti',
    repertoireSide: 'white',
    chapterCount: 4,
    studyCount: 8,
    positionCount: 950,
    moveCount: 1_900,
    commentCount: 475,
    processingStatus: 'ready',
    conflictCount: 0,
    rootFen: 'root',
    processedFile: 'reti.json',
    studies: 8,
    positions: 950,
    opponentChoices: 20,
    repertoireDecisions: 19,
    maximumDepth: 10,
    conflicts: 0,
    validationStatus: 'ready',
    issueCount: 0,
    availableModes: ['book', 'practice'],
  },
];

function visibleOpeningTitles(): string[] {
  const library = screen.queryByRole('region', { name: 'Opening library' });
  return (library ? within(library).queryAllByRole('article') : []).map(
    (article) =>
      within(article).getByRole('heading', { level: 2 }).textContent ?? '',
  );
}

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage());
  dataMocks.loadOpeningIndex.mockReset();
  dataMocks.loadRepertoire.mockReset();
  dataMocks.loadOpeningIndex.mockResolvedValue(openings);
  dataMocks.loadRepertoire.mockImplementation(async (processedFile: string) =>
    ({
      openingId: processedFile.replace('.json', ''),
      title: processedFile,
    }) as CanonicalRepertoire,
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Opening library', () => {
  it('searches case-insensitively without punctuation or diacritics and clears with Escape', async () => {
    const user = userEvent.setup();
    render(<App />);
    const search = await screen.findByRole('searchbox', {
      name: 'Search openings',
    });

    await user.type(search, 'CAROKANN');
    expect(visibleOpeningTitles()).toEqual(['Caro-Kann Defense']);

    await user.clear(search);
    await user.type(search, 'kings-indian');
    expect(visibleOpeningTitles()).toEqual(["King's Indian Defense"]);

    await user.clear(search);
    await user.type(search, 'reti');
    expect(visibleOpeningTitles()).toEqual(['Réti Opening']);

    await user.keyboard('{Escape}');
    expect(search).toHaveValue('');
    expect(visibleOpeningTitles()).toHaveLength(4);
  });

  it('also searches the opening slug', async () => {
    const user = userEvent.setup();
    render(<App />);
    const search = await screen.findByRole('searchbox', {
      name: 'Search openings',
    });

    await user.type(search, 'hypermodern');

    expect(visibleOpeningTitles()).toEqual(['Réti Opening']);
  });

  it('filters by repertoire side and exposes stable total counts', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'Choose an opening' });

    const all = screen.getByRole('button', { name: 'All (7)' });
    const white = screen.getByRole('button', { name: 'White (2)' });
    const black = screen.getByRole('button', { name: 'Black (2)' });
    expect(screen.getByRole('button', { name: 'Combined (3)' })).toBeInTheDocument();
    expect(all).toHaveAttribute('aria-pressed', 'true');

    await user.click(white);
    expect(white).toHaveAttribute('aria-pressed', 'true');
    expect(visibleOpeningTitles()).toEqual(['London System', 'Réti Opening']);

    await user.click(black);
    expect(visibleOpeningTitles()).toEqual([
      'Caro-Kann Defense',
      "King's Indian Defense",
    ]);
    const kingsIndianCard = screen
      .getByRole('heading', { name: "King's Indian Defense" })
      .closest('article');
    if (!kingsIndianCard) throw new Error("King's Indian card is missing.");
    expect(
      within(kingsIndianCard).getByRole('button', {
        name: "Practice King's Indian Defense in Practice Mode",
      }),
    ).toBeDisabled();
  });

  it('sorts alphabetically and by descending study or position counts', async () => {
    const user = userEvent.setup();
    render(<App />);
    const sort = await screen.findByRole('combobox', { name: 'Sort openings' });

    expect(visibleOpeningTitles()).toEqual([
      'Caro-Kann Defense',
      "King's Indian Defense",
      'London System',
      'Réti Opening',
    ]);

    await user.selectOptions(sort, 'studies');
    expect(visibleOpeningTitles()).toEqual([
      'London System',
      'Caro-Kann Defense',
      "King's Indian Defense",
      'Réti Opening',
    ]);

    await user.selectOptions(sort, 'positions');
    expect(visibleOpeningTitles()).toEqual([
      'Caro-Kann Defense',
      'London System',
      'Réti Opening',
      "King's Indian Defense",
    ]);
  });

  it('shows an English empty state when search and filters have no match', async () => {
    const user = userEvent.setup();
    render(<App />);
    const search = await screen.findByRole('searchbox', {
      name: 'Search openings',
    });

    await user.type(search, 'does not exist');
    expect(
      screen.getByRole('heading', {
        name: 'No openings match your search',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Try a different search or repertoire-side filter.'),
    ).toBeInTheDocument();
  });

  it('opens Book and Practice directly with unique accessible card actions', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'Choose an opening' });

    const caroCard = screen
      .getByRole('heading', { name: 'Caro-Kann Defense' })
      .closest('article');
    if (!caroCard) throw new Error('Caro-Kann card is missing.');
    const openBook = within(caroCard).getByRole('button', {
      name: 'Open Caro-Kann Defense in Book Mode',
    });
    expect(openBook).toHaveTextContent('Book');
    await user.click(openBook);
    expect(await screen.findByTestId('opening-workspace')).toHaveAttribute(
      'data-initial-mode',
      'book',
    );

    await user.click(screen.getByRole('button', { name: /Back to library/ }));
    const londonCard = (
      await screen.findByRole('heading', { name: 'London System' })
    ).closest('article');
    if (!londonCard) throw new Error('London card is missing.');
    const practice = within(londonCard).getByRole('button', {
      name: 'Practice London System in Practice Mode',
    });
    expect(practice).toHaveTextContent('Practice');
    await user.click(practice);
    expect(await screen.findByTestId('opening-workspace')).toHaveAttribute(
      'data-initial-mode',
      'practice',
    );
  });

  it('offers Explorer directly and exposes reference-only combined openings', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'Choose an opening' });

    await user.click(screen.getByRole('button', { name: 'Explore Caro-Kann Defense in Explorer' }));
    expect(await screen.findByTestId('opening-workspace')).toHaveAttribute('data-initial-mode', 'explorer');

    await user.click(screen.getByRole('button', { name: /Back to library/ }));
    await user.click(screen.getByRole('button', { name: /Combined \(/ }));
    expect(screen.getByRole('heading', { name: 'Complete White Repertoire' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Full Repertoire Explorer' })).toBeInTheDocument();
    expect(screen.getAllByText('References only').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /Practice Complete/ })).not.toBeInTheDocument();
  });

  it('imports pasted PGN into the searchable local PGN library', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'Choose an opening' });
    const input = screen.getByRole('textbox', { name: 'Paste PGN' });
    fireEvent.change(input, { target: { value: '[Event "Training Game"]\n\n1. e4 c6 2. d4 d5' } });
    await user.click(screen.getByRole('button', { name: 'Import pasted PGN' }));

    expect(screen.getByRole('heading', { name: 'Training Game' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'PGN' })).not.toBeInTheDocument();
    const gameCard = screen.getByRole('heading', { name: 'Training Game' }).closest('article');
    if (!gameCard) throw new Error('Imported game card is missing.');
    expect(within(gameCard).getByText('4', { selector: 'dd' })).toBeInTheDocument();
  });

  it('favorites normal openings without duplicating search results', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'Choose an opening' });
    await user.click(screen.getByRole('button', { name: 'Add Caro-Kann Defense to favorites' }));
    expect(screen.getByRole('region', { name: 'Favorites' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { name: 'Caro-Kann Defense' })).toHaveLength(1);
    const search = screen.getByRole('searchbox', { name: 'Search openings' });
    await user.type(search, 'caro kann');
    expect(screen.queryByRole('region', { name: 'Favorites' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('heading', { name: 'Caro-Kann Defense' })).toHaveLength(1);
  });

  it('loads repertoires lazily and reuses them by processed file', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'Choose an opening' });

    expect(dataMocks.loadRepertoire).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole('button', {
        name: 'Open Caro-Kann Defense in Book Mode',
      }),
    );
    await screen.findByTestId('opening-workspace');
    expect(dataMocks.loadRepertoire).toHaveBeenCalledTimes(1);
    expect(dataMocks.loadRepertoire).toHaveBeenLastCalledWith(
      'caro-kann.json',
      expect.any(AbortSignal),
    );

    await user.click(screen.getByRole('button', { name: /Back to library/ }));
    await user.click(
      screen.getByRole('button', {
        name: 'Practice Caro-Kann Defense in Practice Mode',
      }),
    );
    expect(await screen.findByTestId('opening-workspace')).toHaveAttribute(
      'data-initial-mode',
      'practice',
    );
    expect(dataMocks.loadRepertoire).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: /Back to library/ }));
    await user.click(
      screen.getByRole('button', {
        name: 'Open London System in Book Mode',
      }),
    );
    await screen.findByTestId('opening-workspace');
    expect(dataMocks.loadRepertoire).toHaveBeenCalledTimes(2);
    expect(dataMocks.loadRepertoire).toHaveBeenLastCalledWith(
      'london-system.json',
      expect.any(AbortSignal),
    );
  });
});
