import { buildCanonicalRepertoire } from '../../scripts/lib/build.js';
import type {
  LoadedSources,
  LoadedStudy,
} from '../../scripts/lib/build-input.js';
import type { OpeningIndexEntry } from '../data/repertoire.js';
import {
  stableId,
  type CanonicalRepertoire,
  type RepertoireSide,
} from '../domain/repertoire.js';
import {
  chesslyBrowserEntries,
  extractChesslyZipEntries,
  parseChesslyBrowserFiles,
  parseChesslyFiles,
  parseChesslyZip,
} from './chessly.js';
import { knownCourseSide } from './known-course-sides.js';
import type {
  BrowserImportFile,
  ChesslyStudyImport,
  ImportFileEntry,
  ValidatedImportPackage,
} from './types.js';

export interface BuiltCoursePack {
  index: OpeningIndexEntry;
  repertoire: CanonicalRepertoire;
}

function slugify(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/\p{Mark}/gu, '')
    .toLocaleLowerCase('en')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || `course-${stableId('course', value).slice(-8)}`;
}

function loadedStudy(study: ChesslyStudyImport): LoadedStudy {
  const basePath = study.relativePath.replace(/\/$/, '');
  return {
    sourceType: 'main',
    courseFolder: study.courseFolder,
    studyFolder: study.studyFolder,
    directory: basePath,
    metadata: study.metadata,
    movesPath: `${basePath}/moves.json`,
    commentsPath: `${basePath}/comments.json`,
    moves: structuredClone(study.moves) as NonNullable<LoadedStudy['moves']>,
    comments: structuredClone(study.comments) as NonNullable<LoadedStudy['comments']>,
    movesParseError: null,
    commentsParseError: null,
    rawFiles: [],
  };
}

function maximumDepth(repertoire: CanonicalRepertoire): number {
  const outgoing = new Map<string, string[]>();
  for (const edge of Object.values(repertoire.edges)) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }
  const memo = new Map<string, number>();
  const visit = (position: string, visiting: Set<string>): number => {
    const cached = memo.get(position);
    if (cached !== undefined) return cached;
    if (visiting.has(position)) return 0;
    const nextVisiting = new Set(visiting).add(position);
    const depth = Math.max(
      0,
      ...(outgoing.get(position) ?? []).map(
        (target) => 1 + visit(target, nextVisiting),
      ),
    );
    memo.set(position, depth);
    return depth;
  };
  return visit(repertoire.rootPosition, new Set());
}

function indexFor(
  repertoire: CanonicalRepertoire,
  issueCount: number,
): OpeningIndexEntry {
  const chapters = new Set<string>();
  const studies = new Set<string>();
  for (const edge of Object.values(repertoire.edges)) {
    for (const source of edge.sources) {
      chapters.add(source.chapter);
      studies.add(`${source.courseFolder}\u0000${source.studyFolder}`);
    }
  }
  const opponentTurn = repertoire.openingSide === 'white' ? 'b' : 'w';
  const opponentChoices = Object.values(repertoire.edges).filter(
    (edge) =>
      repertoire.positions[edge.from]?.reachableFromRoot === true &&
      repertoire.positions[edge.from]?.turn === opponentTurn,
  ).length;
  const validationStatus =
    issueCount > 0 || repertoire.summary.unresolvedConflicts > 0
      ? 'partial'
      : 'ready';

  return {
    id: repertoire.openingId,
    slug: repertoire.openingId,
    title: repertoire.title,
    sourcePath: 'local-browser-import',
    sourceCourseUrl: '',
    repertoireSide: repertoire.openingSide,
    chapterCount: chapters.size,
    studyCount: studies.size || repertoire.summary.studies,
    positionCount: repertoire.summary.positions,
    moveCount: repertoire.summary.canonicalEdges,
    commentCount: repertoire.summary.commentObjects,
    processingStatus: validationStatus,
    conflictCount: repertoire.summary.unresolvedConflicts,
    importConflictCount: repertoire.summary.mainCourseConflicts,
    rootFen: repertoire.rootPosition,
    processedFile: `local:${repertoire.openingId}`,
    studies: studies.size || repertoire.summary.studies,
    positions: repertoire.summary.positions,
    opponentChoices,
    repertoireDecisions: Object.keys(
      repertoire.repertoireDecisionNodes,
    ).length,
    maximumDepth: maximumDepth(repertoire),
    conflicts: repertoire.summary.unresolvedConflicts,
    validationStatus,
    issueCount,
    availableModes: ['book', 'practice', 'explorer'],
  };
}

function buildCoursePack(
  preview: ValidatedImportPackage,
  repertoireSide: Exclude<RepertoireSide, 'unresolved'>,
): BuiltCoursePack {
  if (
    !preview.canApply ||
    preview.payload?.kind !== 'chessly-studies' ||
    preview.payload.studies.length === 0
  ) {
    const reason = preview.issues.find((item) => item.severity === 'error');
    throw new Error(
      reason?.message ??
        'Der ausgewählte Ordner enthält keinen vollständigen Chessly-Kurs.',
    );
  }

  const importedStudies = preview.payload.studies;
  const title =
    importedStudies.find(
      (study) => study.metadata.course !== 'nicht eindeutig erkennbar',
    )?.metadata.course ?? importedStudies[0]?.courseFolder ?? 'Imported course';
  const sourceCourseFolder = importedStudies[0]?.courseFolder;
  const id = slugify(
    sourceCourseFolder && sourceCourseFolder !== 'nicht eindeutig erkennbar'
      ? sourceCourseFolder
      : title,
  );
  const fingerprint = stableId(
    'browser-import',
    importedStudies.map((study) => [
      study.relativePath,
      study.metadata,
      Object.keys(study.moves).length,
      Object.keys(study.comments).length,
    ]),
  );
  const loaded: LoadedSources = {
    studies: importedStudies.map(loadedStudy),
    sourceFingerprint: fingerprint,
    mainPresent: true,
    bonusPresent: false,
  };
  const result = buildCanonicalRepertoire(loaded, {
    openingId: id,
    title,
    repertoireSide,
    sourcePath: 'local-browser-import',
    bonusSourcePath: 'local-browser-import-bonus',
  });
  if (
    result.repertoire.summary.positions === 0 ||
    result.repertoire.summary.canonicalEdges === 0
  ) {
    throw new Error('Der Kurs enthält keine verwendbaren Repertoirezüge.');
  }
  const issueCount = Object.values(result.issues).reduce(
    (total, issues) => total + issues.length,
    preview.issues.length,
  );
  return {
    index: indexFor(result.repertoire, issueCount),
    repertoire: result.repertoire,
  };
}

export async function buildCoursePackFromBrowserFiles(
  files: readonly BrowserImportFile[],
  repertoireSide: Exclude<RepertoireSide, 'unresolved'>,
): Promise<BuiltCoursePack> {
  const onlyFile = files.length === 1 ? files[0] : undefined;
  const preview =
    onlyFile?.name.toLocaleLowerCase('en').endsWith('.zip') === true
      ? parseChesslyZip(await onlyFile.arrayBuffer(), {
          sourceType: 'main',
        }, onlyFile.name)
      : await parseChesslyBrowserFiles(files, { sourceType: 'main' });
  return buildCoursePack(preview, repertoireSide);
}

const STUDY_FILE_NAMES = new Set(['moves.json', 'comments.json', 'info.md']);

function entriesByCourse(
  entries: readonly ImportFileEntry[],
): Map<string, ImportFileEntry[]> {
  const result = new Map<string, ImportFileEntry[]>();
  for (const entry of entries) {
    const segments = entry.path.replaceAll('\\', '/').split('/').filter(Boolean);
    if (segments.length < 3 || !STUDY_FILE_NAMES.has(segments.at(-1) ?? '')) {
      continue;
    }
    const courseFolder = segments.at(-3);
    if (!courseFolder) continue;
    result.set(courseFolder, [...(result.get(courseFolder) ?? []), entry]);
  }
  return result;
}

export async function buildCoursePacksFromBrowserFiles(
  files: readonly BrowserImportFile[],
  singleCourseSide: Exclude<RepertoireSide, 'unresolved'>,
): Promise<BuiltCoursePack[]> {
  const onlyFile = files.length === 1 ? files[0] : undefined;
  const entries =
    onlyFile?.name.toLocaleLowerCase('en').endsWith('.zip') === true
      ? extractChesslyZipEntries(await onlyFile.arrayBuffer())
      : await chesslyBrowserEntries(files);
  const grouped = entriesByCourse(entries);
  if (grouped.size <= 1) {
    return [await buildCoursePackFromBrowserFiles(files, singleCourseSide)];
  }

  const unknown = [...grouped.keys()].filter(
    (courseFolder) => knownCourseSide(courseFolder) === undefined,
  );
  if (unknown.length > 0) {
    throw new Error(
      `Für diese Kurse ist Weiß/Schwarz unbekannt: ${unknown.join(', ')}. Bitte einzeln importieren.`,
    );
  }

  return [...grouped.entries()].map(([courseFolder, courseEntries]) =>
    buildCoursePack(
      parseChesslyFiles(courseEntries, { sourceType: 'main' }),
      knownCourseSide(courseFolder)!,
    ),
  );
}
