export const LOCAL_BACKUP_KIND = 'interactive-chessbook-local-backup' as const;
export const LOCAL_BACKUP_VERSION = 1 as const;

export type BoardOrientation = 'white' | 'black';

export interface AppSettings {
  orientation: BoardOrientation;
  showArrows: boolean;
  showHighlights: boolean;
}

export const DEFAULT_APP_SETTINGS: Readonly<AppSettings> = {
  orientation: 'black',
  showArrows: true,
  showHighlights: true,
};

export interface NavigationHistoryEntry {
  whiteTurnPosition: string;
  whiteMoveSan: string;
  blackTurnPosition: string;
  blackMoveSan: string | null;
  resultingWhiteTurnPosition: string | null;
  decisionId: string | null;
  replyCandidateId: string | null;
}

export interface NavigationState {
  currentPosition: string;
  history: NavigationHistoryEntry[];
  historyIndex: number;
  updatedAt: string;
}

export interface LocalMarks {
  threats: string[];
  opportunities: string[];
}

export type LocalOverrideTargetType =
  | 'reply-candidate'
  | 'annotation'
  | 'position';

export interface LocalOverrideTarget {
  type: LocalOverrideTargetType;
  id: string;
}

interface LocalOverrideBase {
  id: string;
  target: LocalOverrideTarget;
  createdAt: string;
  updatedAt: string;
}

export interface LocalTextOverride extends LocalOverrideBase {
  field: 'reply-explanation' | 'resulting-plan';
  value: string | null;
}

export interface LocalMarksOverride extends LocalOverrideBase {
  field: 'arrows' | 'highlights';
  value: LocalMarks | null;
}

export type LocalOverride = LocalTextOverride | LocalMarksOverride;

type NewRecord<T> = T extends unknown
  ? Omit<T, 'id' | 'createdAt' | 'updatedAt'>
  : never;

export type LocalTextOverrideInput = NewRecord<LocalTextOverride>;
export type LocalMarksOverrideInput = NewRecord<LocalMarksOverride>;
export type LocalOverrideInput =
  | LocalTextOverrideInput
  | LocalMarksOverrideInput;

export interface LocalAnnotationContent {
  text: string;
  arrows: LocalMarks | null;
  highlights: LocalMarks | null;
}

export interface LocalReplyAddition {
  id: string;
  san: string;
  resultingWhiteTurnPosition: string;
  replyExplanation: LocalAnnotationContent | null;
  resultingPlan: LocalAnnotationContent | null;
}

/**
 * A locally added decision unit. Multiple records can be linked through their
 * FENs and `branchId` to represent a complete user-authored branch.
 */
export interface LocalAddition {
  id: string;
  sourceType?: SourceType;
  branchId: string | null;
  baseDecisionId: string | null;
  whiteTurnPosition: string;
  whiteMoveSan: string;
  blackTurnPosition: string;
  replies: LocalReplyAddition[];
  createdAt: string;
  updatedAt: string;
}

export type LocalAdditionInput = Omit<
  LocalAddition,
  'createdAt' | 'updatedAt'
>;

export interface LocalConflictSelection {
  decisionId: string;
  replyCandidateId: string;
  updatedAt: string;
}

export interface LocalDataSnapshot {
  overrides: LocalOverride[];
  additions: LocalAddition[];
  conflictSelections: LocalConflictSelection[];
}

export type SnapshotImportMode =
  | 'reject-conflicts'
  | 'keep-existing'
  | 'overwrite'
  | 'replace';

export interface LocalBackup {
  kind: typeof LOCAL_BACKUP_KIND;
  version: typeof LOCAL_BACKUP_VERSION;
  exportedAt: string;
  data: LocalDataSnapshot & {
    settings: AppSettings;
    navigation: NavigationState | null;
  };
}
import type { SourceType } from '../domain/repertoire.js';
