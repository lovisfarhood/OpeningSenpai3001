import type { ImportFileContent } from './types.js';

export function toUint8Array(
  content: Uint8Array | ArrayBuffer,
): Uint8Array {
  return content instanceof Uint8Array
    ? content
    : new Uint8Array(content);
}

export function decodeUtf8(content: ImportFileContent): string {
  if (typeof content === 'string') {
    return content;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(
    toUint8Array(content),
  );
}
