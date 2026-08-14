import type {
  AnnotationMarks,
  CanonicalRepertoire,
  SourceType,
  StudyMetadata,
} from '../domain/repertoire.js';
import type { LocalBackup } from '../storage/types.js';

export const IMPORT_PACKAGE_VERSION = 1 as const;

export type ImportInputKind =
  | 'native-repertoire'
  | 'native-local-backup'
  | 'chessly-studies';

export type ImportPackageSourceType = SourceType | 'mixed';

export type ImportIssueSeverity = 'error' | 'warning';

export type ImportIssueCode =
  | 'duplicate-file'
  | 'invalid-comment'
  | 'invalid-fen'
  | 'invalid-info'
  | 'invalid-json'
  | 'invalid-move'
  | 'invalid-native-document'
  | 'invalid-path'
  | 'invalid-transition'
  | 'invalid-utf8'
  | 'invalid-zip'
  | 'missing-file'
  | 'repertoire-conflict'
  | 'unsupported-file'
  | 'unsupported-version';

export interface ImportIssue {
  readonly code: ImportIssueCode;
  readonly severity: ImportIssueSeverity;
  readonly path: string;
  readonly location: string | null;
  readonly message: string;
}

export interface ImportStatistics {
  readonly addedPositions: number;
  readonly addedMoves: number;
  readonly addedComments: number;
  readonly duplicates: number;
  readonly conflicts: number;
  readonly invalidFiles: number;
  readonly disconnectedGraphParts: number;
  readonly disconnectedPositions: number;
}

export interface RawImportedMove {
  readonly fen: string;
  readonly san: string;
  readonly nextFen: string;
  readonly variationId: string;
  readonly variationIndex: number;
}

export interface RawImportedComment {
  readonly text: string;
  readonly arrows: AnnotationMarks | null;
  readonly highlights: AnnotationMarks | null;
}

export type ImportedMoveFile = Readonly<
  Record<string, readonly RawImportedMove[]>
>;

export type ImportedCommentFile = Readonly<
  Record<string, readonly RawImportedComment[]>
>;

export interface ChesslyStudyImport {
  readonly sourceType: SourceType;
  readonly courseFolder: string;
  readonly studyFolder: string;
  readonly relativePath: string;
  readonly metadata: StudyMetadata;
  readonly moves: ImportedMoveFile;
  readonly comments: ImportedCommentFile;
}

export type ImportPayload =
  | {
      readonly kind: 'native-repertoire';
      readonly repertoire: CanonicalRepertoire;
    }
  | {
      readonly kind: 'native-local-backup';
      readonly backup: LocalBackup;
    }
  | {
      readonly kind: 'chessly-studies';
      readonly studies: readonly ChesslyStudyImport[];
    };

/**
 * A parser result is deliberately a preview package, not a persistence command.
 * Consumers must show the preview and obtain confirmation before applying it.
 */
export interface ValidatedImportPackage {
  readonly packageVersion: typeof IMPORT_PACKAGE_VERSION;
  readonly inputKind: ImportInputKind;
  readonly sourceType: ImportPackageSourceType;
  readonly status: 'ready' | 'invalid';
  readonly canApply: boolean;
  readonly requiresConfirmation: true;
  readonly overwriteExisting: false;
  readonly sourcePriority: readonly ['main', 'bonus', 'user'];
  readonly statistics: ImportStatistics;
  readonly issues: readonly ImportIssue[];
  readonly payload: ImportPayload | null;
}

export type ImportFileContent = string | Uint8Array | ArrayBuffer;

export interface ImportFileEntry {
  readonly path: string;
  readonly content: ImportFileContent;
  readonly sourceType?: SourceType;
}

export interface ChesslyImportOptions {
  /**
   * Explicitly classifies every entry without its own sourceType. If omitted,
   * well-known caro-kann folders are inferred and all other uploads are `user`.
   */
  readonly sourceType?: SourceType;
  readonly existingRepertoire?: CanonicalRepertoire;
}

export interface NativeImportOptions {
  readonly existingRepertoire?: CanonicalRepertoire;
}

export type ImportInput =
  | {
      readonly kind: 'native-json';
      readonly content: ImportFileContent;
      readonly path?: string;
    }
  | {
      readonly kind: 'chessly-files';
      readonly files: readonly ImportFileEntry[];
    }
  | {
      readonly kind: 'chessly-zip';
      readonly content: Uint8Array | ArrayBuffer;
      readonly path?: string;
    };

export interface BrowserImportFile extends Blob {
  readonly name: string;
  readonly webkitRelativePath?: string;
}
