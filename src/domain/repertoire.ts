export const FORMAT_VERSION = '1.0.0' as const;

export const START_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export type SourceType = 'main' | 'bonus' | 'user';
export type BoardTurn = 'w' | 'b';
export type RepertoireSide = 'white' | 'black' | 'unresolved';
export type AnnotationKind = 'reply-explanation' | 'resulting-plan';
export type ConflictStatus =
  | 'resolved'
  | 'resolved-by-source-priority'
  | 'unresolved'
  | 'missing-reply';

export interface AnnotationMarks {
  threats: string[];
  opportunities: string[];
}

export interface StudyMetadata {
  course: string;
  chapter: string;
  study: string;
  courseUrl?: string;
  chapterUrl?: string;
  studyUrl?: string;
}

export interface MoveOrigin extends StudyMetadata {
  id: string;
  sourceType: SourceType;
  courseFolder: string;
  studyFolder: string;
  variationId: string;
  variationIndex: number;
  rawFen: string;
  rawNextFen: string;
}

export interface AnnotationOrigin extends StudyMetadata {
  sourceType: SourceType;
  courseFolder: string;
  studyFolder: string;
  rawFen: string;
}

export interface CanonicalAnnotation {
  id: string;
  normalizedFen: string;
  text: string;
  arrows: AnnotationMarks | null;
  highlights: AnnotationMarks | null;
  sources: AnnotationOrigin[];
}

export interface CanonicalPosition {
  id: string;
  normalizedFen: string;
  turn: BoardTurn;
  fullFens: string[];
  annotations: CanonicalAnnotation[];
  reachableFromRoot: boolean;
}

export interface CanonicalEdge {
  id: string;
  from: string;
  san: string;
  to: string;
  sources: MoveOrigin[];
}

export interface ReplyCandidate {
  id: string;
  replyEdgeId: string;
  san: string;
  blackTurnPosition: string;
  resultingWhiteTurnPosition: string;
  sourceTypes: SourceType[];
  sourceOriginIds: string[];
  replyExplanationIds: string[];
  resultingPlanIds: string[];
}

export interface WhiteMoveOption {
  id: string;
  whiteEdgeId: string;
  san: string;
  blackTurnPosition: string;
  selectedReplyId: string | null;
  conflictStatus: ConflictStatus;
  localSelectionAllowed: boolean;
  candidates: ReplyCandidate[];
}

export interface WhiteTurnNode {
  id: string;
  position: string;
  moves: WhiteMoveOption[];
}

export interface RepertoireMoveCandidate {
  id: string;
  edgeId: string;
  san: string;
  resultingPosition: string;
  sourceTypes: SourceType[];
  explanationIds: string[];
  planIds: string[];
}

export interface RepertoireDecisionNode {
  id: string;
  position: string;
  selectedCandidateId: string | null;
  conflictStatus: ConflictStatus;
  candidates: RepertoireMoveCandidate[];
}

export interface RepertoireSummary {
  studies: number;
  positions: number;
  reachablePositions: number;
  rawMoveEntries: number;
  canonicalEdges: number;
  deduplicatedEdgeOccurrences: number;
  whiteTurnNodes: number;
  activeWhiteDecisions: number;
  incompleteWhiteDecisions: number;
  mainCourseConflicts: number;
  unresolvedConflicts: number;
  commentObjects: number;
  arrows: number;
  highlights: number;
}

export interface RepertoireGraphTopology {
  terminalPositions: string[];
  transpositionPositions: string[];
}

export interface CanonicalRepertoire {
  formatVersion: typeof FORMAT_VERSION;
  generatorVersion: string;
  title: string;
  dataSource: {
    sourceFingerprint: string;
    main: {
      type: 'main';
      path: string;
      present: true;
      studyCount: number;
    };
    bonus: {
      type: 'bonus';
      path: string;
      present: boolean;
      studyCount: number;
      status: string;
    };
    priority: SourceType[];
  };
  openingId: string;
  openingSide: RepertoireSide;
  rootPosition: string;
  summary: RepertoireSummary;
  topology: RepertoireGraphTopology;
  positions: Record<string, CanonicalPosition>;
  edges: Record<string, CanonicalEdge>;
  whiteTurnNodes: Record<string, WhiteTurnNode>;
  repertoireDecisionNodes: Record<string, RepertoireDecisionNode>;
}

export function normalizeFen(fen: string): string {
  const fields = fen.trim().split(/\s+/);
  if (fields.length !== 6) {
    throw new Error(`FEN muss genau 6 Felder enthalten: ${fen}`);
  }
  return fields.slice(0, 4).join(' ');
}

export function fenTurn(fen: string): BoardTurn {
  const turn = normalizeFen(fen).split(' ')[1];
  if (turn !== 'w' && turn !== 'b') {
    throw new Error(`Ungültiges Zugrecht in FEN: ${fen}`);
  }
  return turn;
}

export function stableId(prefix: string, value: unknown): string {
  const input = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${prefix}_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function edgeId(from: string, san: string, to: string): string {
  return stableId('edge', [from, san, to]);
}

export function decisionId(position: string, san: string): string {
  return stableId('decision', [position, san]);
}

export function annotationId(
  normalizedFen: string,
  text: string,
  arrows: AnnotationMarks | null,
  highlights: AnnotationMarks | null,
): string {
  return stableId('annotation', [normalizedFen, text, arrows, highlights]);
}
