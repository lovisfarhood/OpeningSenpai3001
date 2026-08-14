import { Chess, validateFen } from 'chess.js';

import {
  FORMAT_VERSION,
  type AnnotationMarks,
  type CanonicalAnnotation,
  type CanonicalEdge,
  type CanonicalPosition,
  type CanonicalRepertoire,
  type SourceType,
  type WhiteTurnNode,
} from '../domain/repertoire.js';
import { isLocalBackup } from '../storage/validation.js';
import { decodeUtf8 } from './content.js';
import {
  buildPackage,
  calculateStatistics,
  emptyStatistics,
  graphFromRepertoire,
  isRecord,
  issue,
} from './shared.js';
import type {
  ImportFileContent,
  ImportIssue,
  NativeImportOptions,
  ValidatedImportPackage,
} from './types.js';

const SOURCE_TYPES = new Set<SourceType>(['main', 'bonus', 'user']);
const CONFLICT_STATUSES = new Set([
  'resolved',
  'resolved-by-source-priority',
  'unresolved',
  'missing-reply',
]);
const SUMMARY_FIELDS = [
  'studies',
  'positions',
  'reachablePositions',
  'rawMoveEntries',
  'canonicalEdges',
  'deduplicatedEdgeOccurrences',
  'whiteTurnNodes',
  'activeWhiteDecisions',
  'incompleteWhiteDecisions',
  'mainCourseConflicts',
  'unresolvedConflicts',
  'commentObjects',
  'arrows',
  'highlights',
] as const;

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string')
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isSourceType(value: unknown): value is SourceType {
  return typeof value === 'string' && SOURCE_TYPES.has(value as SourceType);
}

function isCanonicalFen(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim().split(/\s+/).length !== 4) {
    return false;
  }
  return validateFen(`${value} 0 1`).ok;
}

function isMarks(
  value: unknown,
  kind: 'arrow' | 'highlight',
): value is AnnotationMarks | null {
  if (value === null) {
    return true;
  }
  if (!isRecord(value)) {
    return false;
  }
  const threats = value.threats;
  const opportunities = value.opportunities;
  if (!isStringArray(threats) || !isStringArray(opportunities)) {
    return false;
  }
  const pattern =
    kind === 'arrow'
      ? /^[a-h][1-8]-[a-h][1-8]$/
      : /^[a-h][1-8]$/;
  return (
    threats.every((item) => pattern.test(item)) &&
    opportunities.every((item) => pattern.test(item))
  );
}

function isStudyMetadata(value: Record<string, unknown>): boolean {
  return (
    typeof value.course === 'string' &&
    typeof value.chapter === 'string' &&
    typeof value.study === 'string'
  );
}

function isAnnotationOrigin(value: unknown): boolean {
  return (
    isRecord(value) &&
    isSourceType(value.sourceType) &&
    typeof value.courseFolder === 'string' &&
    typeof value.studyFolder === 'string' &&
    typeof value.rawFen === 'string' &&
    validateFen(value.rawFen).ok &&
    isStudyMetadata(value)
  );
}

function isMoveOrigin(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    isSourceType(value.sourceType) &&
    typeof value.courseFolder === 'string' &&
    typeof value.studyFolder === 'string' &&
    typeof value.variationId === 'string' &&
    isFiniteNumber(value.variationIndex) &&
    typeof value.rawFen === 'string' &&
    typeof value.rawNextFen === 'string' &&
    validateFen(value.rawFen).ok &&
    validateFen(value.rawNextFen).ok &&
    isStudyMetadata(value)
  );
}

function isAnnotation(value: unknown): value is CanonicalAnnotation {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    isCanonicalFen(value.normalizedFen) &&
    typeof value.text === 'string' &&
    isMarks(value.arrows, 'arrow') &&
    isMarks(value.highlights, 'highlight') &&
    Array.isArray(value.sources) &&
    value.sources.every(isAnnotationOrigin)
  );
}

function isPosition(value: unknown): value is CanonicalPosition {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    isCanonicalFen(value.normalizedFen) &&
    (value.turn === 'w' || value.turn === 'b') &&
    isStringArray(value.fullFens) &&
    value.fullFens.every(
      (fen) =>
        validateFen(fen).ok &&
        fen.trim().split(/\s+/).slice(0, 4).join(' ') ===
          value.normalizedFen,
    ) &&
    Array.isArray(value.annotations) &&
    value.annotations.every(isAnnotation) &&
    typeof value.reachableFromRoot === 'boolean'
  );
}

function isEdge(value: unknown): value is CanonicalEdge {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    isCanonicalFen(value.from) &&
    typeof value.san === 'string' &&
    value.san.length > 0 &&
    isCanonicalFen(value.to) &&
    Array.isArray(value.sources) &&
    value.sources.every(isMoveOrigin)
  );
}

function isCandidate(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.replyEdgeId === 'string' &&
    typeof value.san === 'string' &&
    isCanonicalFen(value.blackTurnPosition) &&
    isCanonicalFen(value.resultingWhiteTurnPosition) &&
    Array.isArray(value.sourceTypes) &&
    value.sourceTypes.every(isSourceType) &&
    isStringArray(value.sourceOriginIds) &&
    isStringArray(value.replyExplanationIds) &&
    isStringArray(value.resultingPlanIds)
  );
}

function isWhiteMove(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.whiteEdgeId === 'string' &&
    typeof value.san === 'string' &&
    isCanonicalFen(value.blackTurnPosition) &&
    (value.selectedReplyId === null ||
      typeof value.selectedReplyId === 'string') &&
    typeof value.conflictStatus === 'string' &&
    CONFLICT_STATUSES.has(value.conflictStatus) &&
    typeof value.localSelectionAllowed === 'boolean' &&
    Array.isArray(value.candidates) &&
    value.candidates.every(isCandidate)
  );
}

function isWhiteTurnNode(value: unknown): value is WhiteTurnNode {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    isCanonicalFen(value.position) &&
    Array.isArray(value.moves) &&
    value.moves.every(isWhiteMove)
  );
}

function isNumericRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    SUMMARY_FIELDS.every((field) => isFiniteNumber(value[field])) &&
    Object.values(value).every((entry) => isFiniteNumber(entry))
  );
}

function isDataSource(value: unknown): boolean {
  if (
    !isRecord(value) ||
    typeof value.sourceFingerprint !== 'string' ||
    !isRecord(value.main) ||
    !isRecord(value.bonus) ||
    !Array.isArray(value.priority) ||
    !value.priority.every(isSourceType)
  ) {
    return false;
  }
  return (
    value.main.type === 'main' &&
    typeof value.main.path === 'string' &&
    value.main.present === true &&
    isFiniteNumber(value.main.studyCount) &&
    value.bonus.type === 'bonus' &&
    typeof value.bonus.path === 'string' &&
    typeof value.bonus.present === 'boolean' &&
    isFiniteNumber(value.bonus.studyCount) &&
    typeof value.bonus.status === 'string'
  );
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

function isCanonicalTransition(edge: CanonicalEdge): boolean {
  try {
    const chess = new Chess(`${edge.from} 0 1`);
    const move = chess.move(edge.san, { strict: true });
    const fields = chess.fen().split(' ');
    fields[3] = nominalEnPassantSquare(move);
    return fields.slice(0, 4).join(' ') === edge.to;
  } catch {
    return false;
  }
}

function canonicalValidationError(value: unknown): string | null {
  if (!isRecord(value)) {
    return 'Die JSON-Wurzel muss ein Objekt sein.';
  }
  if (value.formatVersion !== FORMAT_VERSION) {
    return `Nicht unterstützte formatVersion; erwartet wird ${FORMAT_VERSION}.`;
  }
  if (
    typeof value.generatorVersion !== 'string' ||
    typeof value.title !== 'string' ||
    value.openingSide !== 'black' ||
    !isCanonicalFen(value.rootPosition) ||
    !isDataSource(value.dataSource) ||
    !isNumericRecord(value.summary) ||
    !isRecord(value.positions) ||
    !isRecord(value.edges) ||
    !isRecord(value.whiteTurnNodes)
  ) {
    return 'Pflichtfelder des nativen Repertoireformats fehlen oder sind ungültig.';
  }

  for (const [key, position] of Object.entries(value.positions)) {
    if (
      !isPosition(position) ||
      position.normalizedFen !== key ||
      position.id !== key ||
      position.turn !== key.split(' ')[1] ||
      position.annotations.some(
        (annotation) => annotation.normalizedFen !== key,
      )
    ) {
      return `Ungültige kanonische Position: ${key}.`;
    }
  }
  if (!Object.hasOwn(value.positions, value.rootPosition)) {
    return 'Die Wurzelposition fehlt im Positionsobjekt.';
  }

  for (const [key, edge] of Object.entries(value.edges)) {
    if (
      !isEdge(edge) ||
      edge.id !== key ||
      !Object.hasOwn(value.positions, edge.from) ||
      !Object.hasOwn(value.positions, edge.to) ||
      !isCanonicalTransition(edge)
    ) {
      return `Ungültige oder unverbundene kanonische Kante: ${key}.`;
    }
  }

  const edgeRecord = value.edges;
  for (const [key, node] of Object.entries(value.whiteTurnNodes)) {
    if (
      !isWhiteTurnNode(node) ||
      node.position !== key ||
      key.split(' ')[1] !== 'w' ||
      !Object.hasOwn(value.positions, key) ||
      node.moves.some(
        (move) =>
          !Object.hasOwn(edgeRecord, move.whiteEdgeId) ||
          move.candidates.some(
            (candidate) =>
              !Object.hasOwn(edgeRecord, candidate.replyEdgeId),
          ),
      )
    ) {
      return `Ungültiger White-turn-Knoten: ${key}.`;
    }
  }

  return null;
}

function localBackupValidationError(value: unknown): string | null {
  if (!isRecord(value)) {
    return 'Die JSON-Wurzel muss ein Objekt sein.';
  }
  if (value.version !== 1) {
    return 'Nicht unterstützte Backup-Version; erwartet wird Version 1.';
  }
  if (
    value.kind !== 'interactive-chessbook-local-backup' ||
    typeof value.exportedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.exportedAt)) ||
    !isRecord(value.data)
  ) {
    return 'Pflichtfelder des lokalen Backupformats fehlen oder sind ungültig.';
  }
  if (!isLocalBackup(value)) {
    return 'Die Backup-Nutzdaten sind unvollständig oder ungültig.';
  }
  return null;
}

function parseJson(
  content: ImportFileContent,
  path: string,
): { value: unknown; issues: ImportIssue[] } {
  let text: string;
  try {
    text = decodeUtf8(content);
  } catch (error) {
    return {
      value: null,
      issues: [
        issue(
          'invalid-utf8',
          'error',
          path,
          error instanceof Error ? error.message : String(error),
        ),
      ],
    };
  }
  try {
    return { value: JSON.parse(text) as unknown, issues: [] };
  } catch (error) {
    return {
      value: null,
      issues: [
        issue(
          'invalid-json',
          'error',
          path,
          error instanceof Error ? error.message : String(error),
        ),
      ],
    };
  }
}

function invalidNativePackage(
  path: string,
  importIssue: ImportIssue,
  inputKind: ValidatedImportPackage['inputKind'],
): ValidatedImportPackage {
  return buildPackage({
    inputKind,
    sourceTypes: new Set(['user']),
    issues: [importIssue],
    statistics: { ...emptyStatistics(), invalidFiles: 1 },
    payload: null,
    blocking: true,
  });
}

export function parseNativeImport(
  content: ImportFileContent,
  options: NativeImportOptions = {},
  path = 'interactive-chessbook.json',
): ValidatedImportPackage {
  const parsed = parseJson(content, path);
  const parseIssue = parsed.issues[0];
  if (parseIssue) {
    return invalidNativePackage(path, parseIssue, 'native-repertoire');
  }
  const value = parsed.value;

  if (
    isRecord(value) &&
    value.kind === 'interactive-chessbook-local-backup'
  ) {
    const problem = localBackupValidationError(value);
    if (problem) {
      const code =
        value.version !== 1
          ? 'unsupported-version'
          : 'invalid-native-document';
      return invalidNativePackage(
        path,
        issue(code, 'error', path, problem),
        'native-local-backup',
      );
    }
    if (!isLocalBackup(value)) {
      return invalidNativePackage(
        path,
        issue(
          'invalid-native-document',
          'error',
          path,
          'Die Backup-Nutzdaten sind unvollständig oder ungültig.',
        ),
        'native-local-backup',
      );
    }
    return buildPackage({
      inputKind: 'native-local-backup',
      sourceTypes: new Set(['user']),
      issues: [],
      statistics: emptyStatistics(),
      payload: {
        kind: 'native-local-backup',
        backup: value,
      },
    });
  }

  if (
    isRecord(value) &&
    value.kind === 'interactive-chessbook-repertoire' &&
    value.version !== 1
  ) {
    return invalidNativePackage(
      path,
      issue(
        'unsupported-version',
        'error',
        path,
        'Nicht unterstützte Repertoire-Hüllenversion; erwartet wird Version 1.',
      ),
      'native-repertoire',
    );
  }
  const candidate =
    isRecord(value) &&
    value.kind === 'interactive-chessbook-repertoire'
      ? value.repertoire
      : value;
  const problem = canonicalValidationError(candidate);
  if (problem) {
    const unsupported =
      isRecord(candidate) &&
      Object.hasOwn(candidate, 'formatVersion') &&
      candidate.formatVersion !== FORMAT_VERSION;
    return invalidNativePackage(
      path,
      issue(
        unsupported ? 'unsupported-version' : 'invalid-native-document',
        'error',
        path,
        problem,
      ),
      'native-repertoire',
    );
  }

  const repertoire = candidate as CanonicalRepertoire;
  const graph = graphFromRepertoire(repertoire);
  const sourceTypes = new Set<SourceType>();
  for (const edge of Object.values(repertoire.edges)) {
    for (const source of edge.sources) {
      sourceTypes.add(source.sourceType);
    }
  }
  for (const position of Object.values(repertoire.positions)) {
    for (const annotation of position.annotations) {
      for (const source of annotation.sources) {
        sourceTypes.add(source.sourceType);
      }
    }
  }
  if (sourceTypes.size === 0) {
    sourceTypes.add('user');
  }

  return buildPackage({
    inputKind: 'native-repertoire',
    sourceTypes,
    issues: [],
    statistics: calculateStatistics(
      graph,
      options.existingRepertoire,
      0,
    ),
    payload: { kind: 'native-repertoire', repertoire },
  });
}
