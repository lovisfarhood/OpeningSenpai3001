import {
  LOCAL_BACKUP_KIND,
  LOCAL_BACKUP_VERSION,
  type AppSettings,
  type LocalAddition,
  type LocalAnnotationContent,
  type LocalBackup,
  type LocalConflictSelection,
  type LocalDataSnapshot,
  type LocalMarks,
  type LocalOverride,
  type NavigationState,
} from './types.js';
import { isAppSettings, isNavigationState } from './browser-state.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

function isLocalMarks(value: unknown): value is LocalMarks {
  return (
    isRecord(value) &&
    isStringArray(value.threats) &&
    isStringArray(value.opportunities)
  );
}

function isNullableMarks(value: unknown): value is LocalMarks | null {
  return value === null || isLocalMarks(value);
}

function hasRecordMetadata(value: Record<string, unknown>): boolean {
  return (
    typeof value.id === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string'
  );
}

function isLocalOverride(value: unknown): value is LocalOverride {
  if (!isRecord(value) || !isRecord(value.target) || !hasRecordMetadata(value)) {
    return false;
  }
  const targetType = value.target.type;
  if (
    targetType !== 'reply-candidate' &&
    targetType !== 'annotation' &&
    targetType !== 'position'
  ) {
    return false;
  }
  if (typeof value.target.id !== 'string') {
    return false;
  }
  if (
    value.field === 'reply-explanation' ||
    value.field === 'resulting-plan'
  ) {
    return isNullableString(value.value);
  }
  if (value.field === 'arrows' || value.field === 'highlights') {
    return isNullableMarks(value.value);
  }
  return false;
}

function isLocalAnnotationContent(
  value: unknown,
): value is LocalAnnotationContent {
  return (
    isRecord(value) &&
    typeof value.text === 'string' &&
    isNullableMarks(value.arrows) &&
    isNullableMarks(value.highlights)
  );
}

function isNullableAnnotationContent(
  value: unknown,
): value is LocalAnnotationContent | null {
  return value === null || isLocalAnnotationContent(value);
}

function isLocalAddition(value: unknown): value is LocalAddition {
  if (
    !isRecord(value) ||
    !hasRecordMetadata(value) ||
    (value.sourceType !== undefined &&
      value.sourceType !== 'main' &&
      value.sourceType !== 'bonus' &&
      value.sourceType !== 'user') ||
    !isNullableString(value.branchId) ||
    !isNullableString(value.baseDecisionId) ||
    typeof value.whiteTurnPosition !== 'string' ||
    typeof value.whiteMoveSan !== 'string' ||
    typeof value.blackTurnPosition !== 'string' ||
    !Array.isArray(value.replies)
  ) {
    return false;
  }
  return value.replies.every(
    (reply) =>
      isRecord(reply) &&
      typeof reply.id === 'string' &&
      typeof reply.san === 'string' &&
      typeof reply.resultingWhiteTurnPosition === 'string' &&
      isNullableAnnotationContent(reply.replyExplanation) &&
      isNullableAnnotationContent(reply.resultingPlan),
  );
}

function isLocalConflictSelection(
  value: unknown,
): value is LocalConflictSelection {
  return (
    isRecord(value) &&
    typeof value.decisionId === 'string' &&
    typeof value.replyCandidateId === 'string' &&
    typeof value.updatedAt === 'string'
  );
}

export function isLocalDataSnapshot(
  value: unknown,
): value is LocalDataSnapshot {
  if (
    !isRecord(value) ||
    !Array.isArray(value.overrides) ||
    !Array.isArray(value.additions) ||
    !Array.isArray(value.conflictSelections)
  ) {
    return false;
  }
  return (
    value.overrides.every(isLocalOverride) &&
    value.additions.every(isLocalAddition) &&
    value.conflictSelections.every(isLocalConflictSelection)
  );
}

export function isLocalBackup(value: unknown): value is LocalBackup {
  if (
    !isRecord(value) ||
    value.kind !== LOCAL_BACKUP_KIND ||
    value.version !== LOCAL_BACKUP_VERSION ||
    typeof value.exportedAt !== 'string' ||
    !isRecord(value.data)
  ) {
    return false;
  }
  const data: unknown = value.data;
  return (
    isLocalDataSnapshot(data) &&
    isAppSettings((data as { settings?: unknown }).settings) &&
    ((data as { navigation?: unknown }).navigation === null ||
      isNavigationState((data as { navigation?: unknown }).navigation))
  );
}

export function assertLocalBackup(value: unknown): asserts value is LocalBackup {
  if (!isLocalBackup(value)) {
    throw new Error(
      'Ungültiges oder nicht unterstütztes lokales ChessBook-Backup.',
    );
  }
}

export type { AppSettings, NavigationState };
