import { Chess, validateFen } from 'chess.js';
import { unzipSync } from 'fflate';

import {
  normalizeFen,
  type AnnotationMarks,
  type CanonicalRepertoire,
  type SourceType,
  type StudyMetadata,
} from '../domain/repertoire.js';
import { decodeUtf8, toUint8Array } from './content.js';
import {
  buildPackage,
  calculateStatistics,
  commentKey,
  edgeKey,
  isRecord,
  issue,
  type GraphComment,
  type GraphEdge,
  type ImportGraph,
} from './shared.js';
import type {
  BrowserImportFile,
  ChesslyImportOptions,
  ChesslyStudyImport,
  ImportFileEntry,
  ImportIssue,
  ImportedCommentFile,
  ImportedMoveFile,
  RawImportedComment,
  RawImportedMove,
  ValidatedImportPackage,
} from './types.js';

const REQUIRED_FILES = ['moves.json', 'comments.json', 'info.md'] as const;
const RECOGNIZED_FILES = new Set<string>(REQUIRED_FILES);
const UNKNOWN_METADATA = 'nicht eindeutig erkennbar';

export const ZIP_IMPORT_LIMITS = {
  // The complete 50-course export is about 30 MiB before ZIP compression.
  // Keep enough headroom for archive metadata while preserving ZIP-bomb guards.
  compressedBytes: 64 * 1024 * 1024,
  entryBytes: 10 * 1024 * 1024,
  totalExpandedBytes: 50 * 1024 * 1024,
  entries: 3_000,
} as const;

interface NormalizedEntry extends ImportFileEntry {
  readonly path: string;
}

interface StudyGroup {
  readonly directory: string;
  readonly entries: Map<string, NormalizedEntry>;
  readonly sourceTypes: Set<SourceType>;
}

interface ParseContext {
  readonly issues: ImportIssue[];
  readonly invalidFiles: Set<string>;
}

interface ParsedStudy {
  readonly study: ChesslyStudyImport;
  readonly edges: readonly GraphEdge[];
  readonly comments: readonly GraphComment[];
  readonly positions: ReadonlySet<string>;
  readonly duplicateOccurrences: number;
}

function invalidPackage(
  path: string,
  code: ImportIssue['code'],
  message: string,
  existingRepertoire?: CanonicalRepertoire,
): ValidatedImportPackage {
  const graph: ImportGraph = {
    positions: new Set(),
    edges: [],
    comments: [],
    duplicateOccurrences: 0,
  };
  return buildPackage({
    inputKind: 'chessly-studies',
    sourceTypes: new Set(['user']),
    issues: [issue(code, 'error', path, message)],
    statistics: calculateStatistics(graph, existingRepertoire, 1),
    payload: null,
    blocking: true,
  });
}

function normalizeEntryPath(path: string): string | null {
  if (path.includes('\0')) {
    return null;
  }
  const withSlashes = path.replaceAll('\\', '/').trim();
  if (
    withSlashes.length === 0 ||
    withSlashes.startsWith('/') ||
    /^[a-zA-Z]:\//.test(withSlashes)
  ) {
    return null;
  }
  const parts = withSlashes.split('/').filter((part) => part.length > 0);
  if (
    parts.length === 0 ||
    parts.some((part) => part === '.' || part === '..')
  ) {
    return null;
  }
  return parts.join('/');
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

function pathSegments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

function inferSourceType(path: string): SourceType {
  const segments = pathSegments(path);
  if (segments.includes('caro-kann-bonus')) {
    return 'bonus';
  }
  if (segments.includes('caro-kann')) {
    return 'main';
  }
  return 'user';
}

function metadataFromInfo(
  content: string,
  path: string,
  context: ParseContext,
): StudyMetadata {
  const title = /^#\s+(.+)$/m.exec(content)?.[1]?.trim();
  const course = /^-\s+Kurs:\s*(.+)$/m.exec(content)?.[1]?.trim();
  const chapter = /^-\s+Kapitel:\s*(.+)$/m.exec(content)?.[1]?.trim();
  const study = /^-\s+Study:\s*(.+)$/m.exec(content)?.[1]?.trim();

  const missing = [
    !course ? 'Kurs' : null,
    !chapter ? 'Kapitel' : null,
    !study && !title ? 'Study' : null,
  ].filter((field): field is string => field !== null);
  if (missing.length > 0) {
    context.issues.push(
      issue(
        'invalid-info',
        'warning',
        path,
        `Metadaten nicht vollständig: ${missing.join(', ')}.`,
      ),
    );
  }

  return {
    course: course || UNKNOWN_METADATA,
    chapter: chapter || UNKNOWN_METADATA,
    study: study || title || UNKNOWN_METADATA,
  };
}

function parseJson(
  content: string,
  path: string,
  context: ParseContext,
): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    context.invalidFiles.add(path);
    context.issues.push(
      issue(
        'invalid-json',
        'error',
        path,
        error instanceof Error ? error.message : String(error),
      ),
    );
    return null;
  }
  if (!isRecord(value)) {
    context.invalidFiles.add(path);
    context.issues.push(
      issue(
        'invalid-json',
        'error',
        path,
        'Die JSON-Wurzel muss ein Objekt sein.',
      ),
    );
    return null;
  }
  return value;
}

function parseMarks(
  value: unknown,
  kind: 'arrow' | 'highlight',
): AnnotationMarks | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const { threats, opportunities } = value;
  if (
    !Array.isArray(threats) ||
    !threats.every((item) => typeof item === 'string') ||
    !Array.isArray(opportunities) ||
    !opportunities.every((item) => typeof item === 'string')
  ) {
    return undefined;
  }
  const pattern =
    kind === 'arrow'
      ? /^[a-h][1-8]-[a-h][1-8]$/
      : /^[a-h][1-8]$/;
  if (
    !threats.every((item) => pattern.test(item)) ||
    !opportunities.every((item) => pattern.test(item))
  ) {
    return undefined;
  }
  return {
    threats: [...threats],
    opportunities: [...opportunities],
  };
}

function rawComment(value: unknown): RawImportedComment | null {
  if (!isRecord(value) || typeof value.text !== 'string') {
    return null;
  }
  const arrows = parseMarks(value.arrows, 'arrow');
  const highlights = parseMarks(value.highlights, 'highlight');
  if (arrows === undefined || highlights === undefined) {
    return null;
  }
  return { text: value.text, arrows, highlights };
}

function rawMove(value: unknown): RawImportedMove | null {
  if (
    !isRecord(value) ||
    typeof value.fen !== 'string' ||
    typeof value.san !== 'string' ||
    typeof value.nextFen !== 'string' ||
    typeof value.variationId !== 'string' ||
    typeof value.variationIndex !== 'number' ||
    !Number.isFinite(value.variationIndex)
  ) {
    return null;
  }
  return {
    fen: value.fen,
    san: value.san,
    nextFen: value.nextFen,
    variationId: value.variationId,
    variationIndex: value.variationIndex,
  };
}

function nominalEnPassantSquare(move: {
  readonly from: string;
  readonly to: string;
  isBigPawn(): boolean;
}): string {
  if (!move.isBigPawn()) {
    return '-';
  }
  const file = move.from[0];
  const fromRank = Number(move.from[1]);
  const toRank = Number(move.to[1]);
  return `${file}${(fromRank + toRank) / 2}`;
}

function transitionError(move: RawImportedMove): string | null {
  try {
    const chess = new Chess(move.fen);
    const applied = chess.move(move.san, { strict: true });
    const expectedFields = chess.fen().split(' ');
    expectedFields[3] = nominalEnPassantSquare(applied);
    const expected = expectedFields.join(' ');
    return expected === move.nextFen
      ? null
      : `nextFen stimmt nicht mit dem Zug überein (erwartet ${expected}).`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function parseMoves(
  root: Record<string, unknown>,
  path: string,
  sourceType: SourceType,
  context: ParseContext,
): {
  file: ImportedMoveFile;
  edges: GraphEdge[];
  positions: Set<string>;
  duplicates: number;
} | null {
  const result: Record<string, RawImportedMove[]> = {};
  const uniqueEdges = new Map<string, GraphEdge>();
  const positions = new Set<string>();
  let duplicates = 0;
  let valid = true;

  for (const [fenKey, entries] of Object.entries(root)) {
    const keyValidation = validateFen(fenKey);
    if (!keyValidation.ok) {
      valid = false;
      context.issues.push(
        issue(
          'invalid-fen',
          'error',
          path,
          keyValidation.error || 'Ungültige FEN.',
          fenKey,
        ),
      );
      continue;
    }
    if (!Array.isArray(entries)) {
      valid = false;
      context.issues.push(
        issue(
          'invalid-move',
          'error',
          path,
          'Der FEN-Wert muss ein Array sein.',
          fenKey,
        ),
      );
      continue;
    }

    const parsedEntries: RawImportedMove[] = [];
    for (const [index, value] of entries.entries()) {
      const location = `${fenKey}[${index}]`;
      const move = rawMove(value);
      if (!move) {
        valid = false;
        context.issues.push(
          issue(
            'invalid-move',
            'error',
            path,
            'Move-Eintrag hat nicht das erwartete Chessly-Format.',
            location,
          ),
        );
        continue;
      }
      if (move.fen !== fenKey) {
        valid = false;
        context.issues.push(
          issue(
            'invalid-move',
            'error',
            path,
            'Der FEN-Schlüssel stimmt nicht mit move.fen überein.',
            location,
          ),
        );
        continue;
      }
      const nextValidation = validateFen(move.nextFen);
      if (!nextValidation.ok) {
        valid = false;
        context.issues.push(
          issue(
            'invalid-fen',
            'error',
            path,
            nextValidation.error || 'Ungültige nextFen.',
            `${location}.nextFen`,
          ),
        );
        continue;
      }
      const problem = transitionError(move);
      if (problem) {
        valid = false;
        context.issues.push(
          issue(
            'invalid-transition',
            'error',
            path,
            problem,
            location,
          ),
        );
        continue;
      }

      parsedEntries.push(move);
      const edge: GraphEdge = {
        from: normalizeFen(move.fen),
        san: move.san,
        to: normalizeFen(move.nextFen),
        sourceType,
      };
      positions.add(edge.from);
      positions.add(edge.to);
      const key = edgeKey(edge);
      if (uniqueEdges.has(key)) {
        duplicates += 1;
      } else {
        uniqueEdges.set(key, edge);
      }
    }
    result[fenKey] = parsedEntries;
  }

  if (!valid) {
    context.invalidFiles.add(path);
    return null;
  }
  return {
    file: result,
    edges: [...uniqueEdges.values()],
    positions,
    duplicates,
  };
}

function parseComments(
  root: Record<string, unknown>,
  path: string,
  context: ParseContext,
): {
  file: ImportedCommentFile;
  comments: GraphComment[];
  positions: Set<string>;
  duplicates: number;
} | null {
  const result: Record<string, RawImportedComment[]> = {};
  const uniqueComments = new Map<string, GraphComment>();
  const positions = new Set<string>();
  let duplicates = 0;
  let valid = true;

  for (const [fen, entries] of Object.entries(root)) {
    const validation = validateFen(fen);
    if (!validation.ok) {
      valid = false;
      context.issues.push(
        issue(
          'invalid-fen',
          'error',
          path,
          validation.error || 'Ungültige FEN.',
          fen,
        ),
      );
      continue;
    }
    if (!Array.isArray(entries)) {
      valid = false;
      context.issues.push(
        issue(
          'invalid-comment',
          'error',
          path,
          'Der FEN-Wert muss ein Array sein.',
          fen,
        ),
      );
      continue;
    }

    const normalized = normalizeFen(fen);
    positions.add(normalized);
    const parsedEntries: RawImportedComment[] = [];
    for (const [index, value] of entries.entries()) {
      const parsed = rawComment(value);
      if (!parsed) {
        valid = false;
        context.issues.push(
          issue(
            'invalid-comment',
            'error',
            path,
            'Kommentar hat nicht das erwartete Chessly-Format.',
            `${fen}[${index}]`,
          ),
        );
        continue;
      }
      parsedEntries.push(parsed);
      const graphComment: GraphComment = {
        position: normalized,
        comment: parsed,
      };
      const key = commentKey(normalized, parsed);
      if (uniqueComments.has(key)) {
        duplicates += 1;
      } else {
        uniqueComments.set(key, graphComment);
      }
    }
    result[fen] = parsedEntries;
  }

  if (!valid) {
    context.invalidFiles.add(path);
    return null;
  }
  return {
    file: result,
    comments: [...uniqueComments.values()],
    positions,
    duplicates,
  };
}

function decodeEntry(
  entry: NormalizedEntry,
  context: ParseContext,
): string | null {
  try {
    return decodeUtf8(entry.content);
  } catch (error) {
    context.invalidFiles.add(entry.path);
    context.issues.push(
      issue(
        'invalid-utf8',
        'error',
        entry.path,
        error instanceof Error ? error.message : String(error),
      ),
    );
    return null;
  }
}

function sourceTypeForGroup(
  group: StudyGroup,
  options: ChesslyImportOptions,
  context: ParseContext,
): SourceType | null {
  if (group.sourceTypes.size > 1) {
    for (const entry of group.entries.values()) {
      context.invalidFiles.add(entry.path);
    }
    context.issues.push(
      issue(
        'invalid-path',
        'error',
        group.directory,
        'Dateien derselben Study haben widersprüchliche sourceType-Werte.',
      ),
    );
    return null;
  }
  return (
    group.sourceTypes.values().next().value ??
    options.sourceType ??
    inferSourceType(group.directory)
  );
}

function parseStudy(
  group: StudyGroup,
  options: ChesslyImportOptions,
  context: ParseContext,
): ParsedStudy | null {
  const sourceType = sourceTypeForGroup(group, options, context);
  if (!sourceType) {
    return null;
  }

  let missing = false;
  for (const required of REQUIRED_FILES) {
    if (!group.entries.has(required)) {
      const missingPath = `${group.directory}/${required}`;
      context.invalidFiles.add(missingPath);
      context.issues.push(
        issue(
          'missing-file',
          'error',
          missingPath,
          `Erforderliche Datei ${required} fehlt.`,
        ),
      );
      missing = true;
    }
  }
  if (missing) {
    return null;
  }

  const movesEntry = group.entries.get('moves.json');
  const commentsEntry = group.entries.get('comments.json');
  const infoEntry = group.entries.get('info.md');
  if (!movesEntry || !commentsEntry || !infoEntry) {
    return null;
  }
  const movesContent = decodeEntry(movesEntry, context);
  const commentsContent = decodeEntry(commentsEntry, context);
  const infoContent = decodeEntry(infoEntry, context);
  if (
    movesContent === null ||
    commentsContent === null ||
    infoContent === null
  ) {
    return null;
  }

  const movesRoot = parseJson(movesContent, movesEntry.path, context);
  const commentsRoot = parseJson(
    commentsContent,
    commentsEntry.path,
    context,
  );
  if (!movesRoot || !commentsRoot) {
    return null;
  }
  const parsedMoves = parseMoves(
    movesRoot,
    movesEntry.path,
    sourceType,
    context,
  );
  const parsedComments = parseComments(
    commentsRoot,
    commentsEntry.path,
    context,
  );
  if (!parsedMoves || !parsedComments) {
    return null;
  }

  const segments = pathSegments(group.directory);
  const studyFolder = segments.at(-1);
  if (!studyFolder) {
    return null;
  }
  const courseFolder = segments.at(-2) ?? UNKNOWN_METADATA;
  const positions = new Set([
    ...parsedMoves.positions,
    ...parsedComments.positions,
  ]);
  return {
    study: {
      sourceType,
      courseFolder,
      studyFolder,
      relativePath: group.directory,
      metadata: metadataFromInfo(infoContent, infoEntry.path, context),
      moves: parsedMoves.file,
      comments: parsedComments.file,
    },
    edges: parsedMoves.edges,
    comments: parsedComments.comments,
    positions,
    duplicateOccurrences:
      parsedMoves.duplicates + parsedComments.duplicates,
  };
}

function groupsFromEntries(
  entries: readonly ImportFileEntry[],
  options: ChesslyImportOptions,
  context: ParseContext,
): Map<string, StudyGroup> {
  const groups = new Map<string, StudyGroup>();
  for (const [index, entry] of entries.entries()) {
    const normalizedPath = normalizeEntryPath(entry.path);
    if (!normalizedPath) {
      const displayPath = entry.path || `<Datei ${index + 1}>`;
      context.invalidFiles.add(`${displayPath}#${index}`);
      context.issues.push(
        issue(
          'invalid-path',
          'error',
          displayPath,
          'Absolute Pfade, leere Pfade und Pfadnavigation sind nicht erlaubt.',
        ),
      );
      continue;
    }
    if (
      normalizedPath.startsWith('__MACOSX/') ||
      basename(normalizedPath) === '.DS_Store' ||
      normalizedPath.endsWith('/')
    ) {
      continue;
    }
    const fileName = basename(normalizedPath);
    if (!RECOGNIZED_FILES.has(fileName)) {
      context.issues.push(
        issue(
          'unsupported-file',
          'warning',
          normalizedPath,
          'Datei wird ignoriert; sie gehört nicht zum Chessly-Study-Format.',
        ),
      );
      continue;
    }
    const directory = dirname(normalizedPath);
    if (!directory) {
      context.invalidFiles.add(normalizedPath);
      context.issues.push(
        issue(
          'invalid-path',
          'error',
          normalizedPath,
          'Chessly-Dateien müssen in einem Study-Ordner liegen.',
        ),
      );
      continue;
    }

    const group = groups.get(directory) ?? {
      directory,
      entries: new Map<string, NormalizedEntry>(),
      sourceTypes: new Set<SourceType>(),
    };
    if (group.entries.has(fileName)) {
      context.invalidFiles.add(`${normalizedPath}#duplicate-${index}`);
      context.issues.push(
        issue(
          'duplicate-file',
          'error',
          normalizedPath,
          'Doppelte Datei wird nicht überschrieben.',
        ),
      );
      groups.set(directory, group);
      continue;
    }
    group.entries.set(fileName, { ...entry, path: normalizedPath });
    group.sourceTypes.add(
      entry.sourceType ??
        options.sourceType ??
        inferSourceType(normalizedPath),
    );
    groups.set(directory, group);
  }
  return groups;
}

export function parseChesslyFiles(
  entries: readonly ImportFileEntry[],
  options: ChesslyImportOptions = {},
): ValidatedImportPackage {
  const context: ParseContext = {
    issues: [],
    invalidFiles: new Set(),
  };
  const groups = groupsFromEntries(entries, options, context);
  const parsed = [...groups.values()]
    .sort((left, right) => left.directory.localeCompare(right.directory, 'en'))
    .map((group) => parseStudy(group, options, context))
    .filter((study): study is ParsedStudy => study !== null);

  const graph: ImportGraph = {
    positions: new Set(parsed.flatMap((item) => [...item.positions])),
    edges: parsed.flatMap((item) => item.edges),
    comments: parsed.flatMap((item) => item.comments),
    duplicateOccurrences: parsed.reduce(
      (total, item) => total + item.duplicateOccurrences,
      0,
    ),
  };

  // Count occurrences deduplicated across study boundaries as well.
  const edgeOccurrences = new Set<string>();
  const commentOccurrences = new Set<string>();
  let crossStudyDuplicates = 0;
  for (const edge of graph.edges) {
    const key = edgeKey(edge);
    if (edgeOccurrences.has(key)) {
      crossStudyDuplicates += 1;
    } else {
      edgeOccurrences.add(key);
    }
  }
  for (const comment of graph.comments) {
    const key = commentKey(comment.position, comment.comment);
    if (commentOccurrences.has(key)) {
      crossStudyDuplicates += 1;
    } else {
      commentOccurrences.add(key);
    }
  }
  const deduplicatedGraph: ImportGraph = {
    positions: graph.positions,
    edges: [...new Map(graph.edges.map((edge) => [edgeKey(edge), edge])).values()],
    comments: [
      ...new Map(
        graph.comments.map((comment) => [
          commentKey(comment.position, comment.comment),
          comment,
        ]),
      ).values(),
    ],
    duplicateOccurrences:
      graph.duplicateOccurrences + crossStudyDuplicates,
  };

  const sourceTypes = new Set(parsed.map((item) => item.study.sourceType));
  if (sourceTypes.size === 0) {
    sourceTypes.add(options.sourceType ?? 'user');
  }
  const payload =
    parsed.length > 0
      ? {
          kind: 'chessly-studies' as const,
          studies: parsed.map((item) => item.study),
        }
      : null;
  return buildPackage({
    inputKind: 'chessly-studies',
    sourceTypes,
    issues: context.issues,
    statistics: calculateStatistics(
      deduplicatedGraph,
      options.existingRepertoire,
      context.invalidFiles.size,
    ),
    payload,
    blocking: parsed.length === 0,
  });
}

export function parseChesslyZip(
  content: Uint8Array | ArrayBuffer,
  options: ChesslyImportOptions = {},
  path = 'import.zip',
): ValidatedImportPackage {
  try {
    return parseChesslyFiles(extractChesslyZipEntries(content), options);
  } catch (error) {
    return invalidPackage(
      path,
      'invalid-zip',
      error instanceof Error ? error.message : String(error),
      options.existingRepertoire,
    );
  }
}

export function extractChesslyZipEntries(
  content: Uint8Array | ArrayBuffer,
): ImportFileEntry[] {
  const bytes = toUint8Array(content);
  if (bytes.byteLength > ZIP_IMPORT_LIMITS.compressedBytes) {
    throw new Error(
      `ZIP ist größer als ${ZIP_IMPORT_LIMITS.compressedBytes} Bytes.`,
    );
  }

  let entryCount = 0;
  let expandedBytes = 0;
  const files = unzipSync(bytes, {
    filter: (entry) => {
      entryCount += 1;
      expandedBytes += entry.originalSize;
      if (
        entryCount > ZIP_IMPORT_LIMITS.entries ||
        entry.originalSize > ZIP_IMPORT_LIMITS.entryBytes ||
        expandedBytes > ZIP_IMPORT_LIMITS.totalExpandedBytes
      ) {
        throw new Error('ZIP überschreitet die sicheren Importgrenzen.');
      }
      return !entry.name.endsWith('/');
    },
  });
  return Object.entries(files).map(
    ([entryPath, entryContent]): ImportFileEntry => ({
      path: entryPath,
      content: entryContent,
    }),
  );
}

export async function parseChesslyBrowserFiles(
  files: readonly BrowserImportFile[],
  options: ChesslyImportOptions = {},
): Promise<ValidatedImportPackage> {
  return parseChesslyFiles(await chesslyBrowserEntries(files), options);
}

export async function chesslyBrowserEntries(
  files: readonly BrowserImportFile[],
): Promise<ImportFileEntry[]> {
  return Promise.all(
    files.map(async (file): Promise<ImportFileEntry> => ({
      path: file.webkitRelativePath || file.name,
      content: await file.arrayBuffer(),
    })),
  );
}
