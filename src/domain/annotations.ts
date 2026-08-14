import type {
  AnnotationOrigin,
  CanonicalAnnotation,
  CanonicalEdge,
  CanonicalRepertoire,
  MoveOrigin,
} from './repertoire.js';

function studyKey(origin: AnnotationOrigin | MoveOrigin): string {
  return `${origin.courseFolder}\u0000${origin.studyFolder}`;
}

function sameRawPosition(left: string, right: string): boolean {
  return left.trim() === right.trim();
}

/**
 * Chessly comments are keyed by the position before the described repertoire
 * move. They therefore become visible only after that edge has been played.
 */
export function annotationsAfterEdge(
  repertoire: CanonicalRepertoire,
  edge: CanonicalEdge | null | undefined,
): CanonicalAnnotation[] {
  if (!edge) return [];
  const originsByStudy = new Map<string, MoveOrigin[]>();
  for (const origin of edge.sources) {
    const key = studyKey(origin);
    originsByStudy.set(key, [...(originsByStudy.get(key) ?? []), origin]);
  }

  return (repertoire.positions[edge.from]?.annotations ?? []).flatMap(
    (annotation) => {
      const sources = annotation.sources.filter((source) =>
        (originsByStudy.get(studyKey(source)) ?? []).some((origin) =>
          sameRawPosition(source.rawFen, origin.rawFen),
        ),
      );
      return sources.length > 0 ? [{ ...annotation, sources }] : [];
    },
  );
}

