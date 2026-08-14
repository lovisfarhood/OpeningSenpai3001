import type {
  SourceType,
  StudyMetadata,
} from '../../src/domain/repertoire.js';
import type { RawCommentFile, RawMoveFile } from './raw-types.js';

export interface LoadedStudy {
  sourceType: SourceType;
  courseFolder: string;
  studyFolder: string;
  directory: string;
  metadata: StudyMetadata;
  movesPath: string;
  commentsPath: string;
  moves: RawMoveFile | null;
  comments: RawCommentFile | null;
  movesParseError: string | null;
  commentsParseError: string | null;
  rawFiles: Array<{
    relativePath: string;
    content: string;
  }>;
}

export interface LoadedSources {
  studies: LoadedStudy[];
  sourceFingerprint: string;
  mainPresent: boolean;
  bonusPresent: boolean;
}
