import type {
  CanonicalRepertoire,
  ConflictStatus,
  SourceType,
} from '../../src/domain/repertoire.js';

export interface AuditIssue {
  sourceType: SourceType;
  studyFolder: string;
  file: string;
  location: string;
  message: string;
}

export interface DuplicateEdgeGroup {
  edgeId: string;
  from: string;
  san: string;
  to: string;
  occurrences: number;
  studies: string[];
  variationIds: string[];
}

export interface DecisionConflict {
  decisionId: string;
  position: string;
  whiteMove: string;
  status: ConflictStatus;
  selectedReplyId: string | null;
  candidates: Array<{
    id: string;
    san: string;
    resultingPosition: string;
    sourceTypes: SourceType[];
    studies: string[];
  }>;
}

export interface AuditMetrics {
  studyFolders: number;
  mainStudyFolders: number;
  bonusStudyFolders: number;
  validMovesJson: number;
  validCommentsJson: number;
  distinctFullFens: number;
  distinctNormalizedFens: number;
  rawMoveEntries: number;
  distinctVariationIds: number;
  variationIndexOccurrences: number;
  distinctVariationIndexValues: number;
  fullFenPositionsWithComments: number;
  normalizedPositionsWithComments: number;
  commentObjects: number;
  arrows: number;
  highlights: number;
  arrowCategoryCollisions: number;
  highlightCategoryCollisions: number;
  invalidJsonFiles: number;
  invalidFens: number;
  invalidSanMoves: number;
  invalidNextFenTransitions: number;
  keyFenMismatches: number;
  disconnectedPositions: number;
  disconnectedEdges: number;
  nextFenReferencesWithoutReachableConnection: number;
  terminalTargetPositions: number;
  canonicalEdges: number;
  duplicateEdgeGroups: number;
  deduplicatedEdgeOccurrences: number;
  positionsWithMultipleOutgoingMoves: number;
  whitePositionsWithMultipleMoves: number;
  blackPositionsWithMultipleReplies: number;
  whiteTurnPositions: number;
  blackTurnPositions: number;
  whiteDecisionKeys: number;
  completeDecisionUnits: number;
  incompleteDecisionUnits: number;
  mainCourseConflicts: number;
  unresolvedConflicts: number;
  decisionsWithPreReplyComments: number;
  decisionsWithPostReplyComments: number;
  decisionsWithBothCommentTypes: number;
  decisionsWithOnlyPreReplyComments: number;
  decisionsWithOnlyPostReplyComments: number;
  decisionsWithoutComments: number;
}

export interface ConflictReport {
  formatVersion: '1.0.0';
  sourceFingerprint: string;
  bonusDataPresent: boolean;
  bonusStatus: string;
  summary: {
    mainCourseConflicts: number;
    unresolvedConflicts: number;
    missingReplies: number;
    resolvedBySourcePriority: number;
  };
  conflicts: DecisionConflict[];
  missingReplies: DecisionConflict[];
}

export interface BuildResult {
  repertoire: CanonicalRepertoire;
  metrics: AuditMetrics;
  issues: {
    invalidJson: AuditIssue[];
    invalidFens: AuditIssue[];
    invalidSan: AuditIssue[];
    invalidNextFen: AuditIssue[];
    keyFenMismatches: AuditIssue[];
    invalidMoveEntries: AuditIssue[];
    invalidCommentEntries: AuditIssue[];
    disconnectedPositions: string[];
    disconnectedEdges: string[];
  };
  duplicateGroups: DuplicateEdgeGroup[];
  conflictReport: ConflictReport;
}
