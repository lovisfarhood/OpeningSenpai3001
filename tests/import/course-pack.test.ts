import 'fake-indexeddb/auto';

import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';

import { START_FEN } from '../../src/domain/repertoire.js';
import {
  buildCoursePackFromBrowserFiles,
  buildCoursePacksFromBrowserFiles,
} from '../../src/import/course-pack.js';
import type { BrowserImportFile } from '../../src/import/types.js';
import { CoursePackRepository } from '../../src/storage/course-packs.js';
import { databaseName } from '../storage/test-utils.js';

function importedFile(
  path: string,
  content: string,
): BrowserImportFile {
  const file = new Blob([content]) as BrowserImportFile;
  Object.defineProperties(file, {
    name: { value: path.slice(path.lastIndexOf('/') + 1) },
    webkitRelativePath: { value: path },
  });
  return file;
}

function fixtureFiles(
  courseFolder = 'fixture-course',
  courseTitle = 'My Private Course',
): BrowserImportFile[] {
  const first = new Chess(START_FEN);
  const white = first.move('e4', { strict: true });
  const afterWhite = first.fen().split(' ');
  afterWhite[3] = `${white.from[0]}${(Number(white.from[1]) + Number(white.to[1])) / 2}`;
  const whiteFen = afterWhite.join(' ');
  const second = new Chess(whiteFen);
  const black = second.move('c6', { strict: true });
  const afterBlack = second.fen().split(' ');
  afterBlack[3] = black.isBigPawn()
    ? `${black.from[0]}${(Number(black.from[1]) + Number(black.to[1])) / 2}`
    : '-';
  const blackFen = afterBlack.join(' ');
  const moves = {
    [START_FEN]: [
      {
        fen: START_FEN,
        san: 'e4',
        nextFen: whiteFen,
        variationId: 'fixture-line',
        variationIndex: 1,
      },
    ],
    [whiteFen]: [
      {
        fen: whiteFen,
        san: 'c6',
        nextFen: blackFen,
        variationId: 'fixture-line',
        variationIndex: 1,
      },
    ],
  };
  const base = `${courseFolder}/01_Study`;
  return [
    importedFile(`${base}/moves.json`, JSON.stringify(moves)),
    importedFile(`${base}/comments.json`, '{}'),
    importedFile(
      `${base}/info.md`,
      `# First Study\n\n- Kurs: ${courseTitle}\n- Kapitel: Start\n- Study: First Study\n`,
    ),
  ];
}

describe('private browser course packs', () => {
  it('builds and persists one selected course without a server asset', async () => {
    const pack = await buildCoursePackFromBrowserFiles(
      fixtureFiles(),
      'white',
    );
    expect(pack.index).toMatchObject({
      id: 'fixture-course',
      title: 'My Private Course',
      repertoireSide: 'white',
      processedFile: 'local:fixture-course',
      availableModes: ['book', 'practice', 'explorer'],
    });
    expect(pack.repertoire.summary.canonicalEdges).toBe(2);

    const repository = new CoursePackRepository({
      databaseName: databaseName('course-packs'),
      now: () => '2026-08-14T12:00:00.000Z',
    });
    await repository.save(pack.index, pack.repertoire);
    expect((await repository.list()).map((item) => item.id)).toEqual([
      'fixture-course',
    ]);
    expect((await repository.get('fixture-course'))?.repertoire.title).toBe(
      'My Private Course',
    );
    await repository.close();
  });

  it('splits a complete chessly folder and assigns known course sides', async () => {
    const packs = await buildCoursePacksFromBrowserFiles(
      [
        ...fixtureFiles('vienna-game', '1.e4 Part 1: The Vienna'),
        ...fixtureFiles('caro-kann', 'Caro-Kann Defense'),
      ],
      'white',
    );
    expect(
      packs
        .map((pack) => [pack.index.id, pack.index.repertoireSide])
        .sort(),
    ).toEqual([
      ['caro-kann', 'black'],
      ['vienna-game', 'white'],
    ]);
  });
});
