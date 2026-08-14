import type {
  AnnotationOrigin,
  CanonicalAnnotation,
  MoveOrigin,
  SourceType,
} from '../../src/domain/repertoire.js';

const SOURCE_RANK: Record<SourceType, number> = {
  main: 0,
  bonus: 1,
  user: 2,
};

export function compareText(left: string, right: string): number {
  return left.localeCompare(right, 'en');
}

export function compareSourceTypes(left: SourceType, right: SourceType): number {
  return SOURCE_RANK[left] - SOURCE_RANK[right];
}

export function compareMoveOrigins(left: MoveOrigin, right: MoveOrigin): number {
  return (
    compareSourceTypes(left.sourceType, right.sourceType) ||
    compareText(left.courseFolder, right.courseFolder) ||
    compareText(left.studyFolder, right.studyFolder) ||
    left.variationIndex - right.variationIndex ||
    compareText(left.variationId, right.variationId) ||
    compareText(left.rawFen, right.rawFen) ||
    compareText(left.rawNextFen, right.rawNextFen)
  );
}

export function compareAnnotationOrigins(
  left: AnnotationOrigin,
  right: AnnotationOrigin,
): number {
  return (
    compareSourceTypes(left.sourceType, right.sourceType) ||
    compareText(left.courseFolder, right.courseFolder) ||
    compareText(left.studyFolder, right.studyFolder) ||
    compareText(left.rawFen, right.rawFen)
  );
}

export function compareAnnotations(
  left: CanonicalAnnotation,
  right: CanonicalAnnotation,
): number {
  return compareText(left.id, right.id);
}

export function uniqueSorted<T>(
  values: Iterable<T>,
  key: (value: T) => string,
  compare: (left: T, right: T) => number,
): T[] {
  const result = new Map<string, T>();
  for (const value of values) {
    if (!result.has(key(value))) {
      result.set(key(value), value);
    }
  }
  return [...result.values()].sort(compare);
}

export function sortRecord<T>(entries: Iterable<readonly [string, T]>): Record<string, T> {
  return Object.fromEntries(
    [...entries].sort(([left], [right]) => compareText(left, right)),
  );
}
