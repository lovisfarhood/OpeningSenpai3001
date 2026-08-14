import {
  parseChesslyBrowserFiles,
  parseChesslyFiles,
  parseChesslyZip,
} from './chessly.js';
import { parseNativeImport } from './native.js';
import type {
  BrowserImportFile,
  ChesslyImportOptions,
  ImportInput,
  NativeImportOptions,
  ValidatedImportPackage,
} from './types.js';

export {
  parseChesslyBrowserFiles,
  parseChesslyFiles,
  parseChesslyZip,
  parseNativeImport,
};
export { ZIP_IMPORT_LIMITS } from './chessly.js';
export { IMPORT_PACKAGE_VERSION } from './types.js';
export type * from './types.js';
export { importPackageToLocalAdditions } from './to-local-additions.js';
export { buildCoursePackFromBrowserFiles } from './course-pack.js';
export type { BuiltCoursePack } from './course-pack.js';

export function parseImportInput(
  input: ImportInput,
  options: ChesslyImportOptions & NativeImportOptions = {},
): ValidatedImportPackage {
  switch (input.kind) {
    case 'native-json':
      return parseNativeImport(
        input.content,
        options,
        input.path ?? 'interactive-chessbook.json',
      );
    case 'chessly-files':
      return parseChesslyFiles(input.files, options);
    case 'chessly-zip':
      return parseChesslyZip(
        input.content,
        options,
        input.path ?? 'import.zip',
      );
  }
}

export async function parseBrowserImportFiles(
  files: readonly BrowserImportFile[],
  options: ChesslyImportOptions & NativeImportOptions = {},
): Promise<ValidatedImportPackage> {
  if (files.length === 1) {
    const file = files[0];
    if (file?.name.toLocaleLowerCase('en').endsWith('.zip')) {
      return parseChesslyZip(
        await file.arrayBuffer(),
        options,
        file.name,
      );
    }
    if (file?.name.toLocaleLowerCase('en').endsWith('.json')) {
      return parseNativeImport(
        await file.arrayBuffer(),
        options,
        file.name,
      );
    }
  }
  return parseChesslyBrowserFiles(files, options);
}
