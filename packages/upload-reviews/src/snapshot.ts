import type { BundleFile } from '../../contracts/src/index.js';
import { digestBytes, validateBundle } from '../../storage/src/index.js';
import {
  MAX_UPLOAD_REVIEW_TEXT_CHARS,
  MAX_UPLOAD_REVIEW_TOTAL_TEXT_CHARS,
  type UploadReviewSnapshot,
} from './index.js';

const TEXT_FILENAMES = new Set(['skill.md', 'readme', 'readme.md', 'license', 'license.md']);
const TEXT_EXTENSIONS = new Set([
  '.c', '.cc', '.cfg', '.conf', '.cpp', '.css', '.csv', '.go', '.h', '.hpp', '.html', '.ini',
  '.java', '.js', '.json', '.jsx', '.log', '.md', '.mjs', '.py', '.rs', '.sh', '.sql', '.toml',
  '.ts', '.tsx', '.txt', '.yaml', '.yml',
]);
const UNSUPPORTED_TEXT_CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

/**
 * Convert a validated canonical draft bundle into the bounded reviewer view.
 * Only known text paths under the text limit receive decoded contents; every
 * other file is represented by digest/size metadata and is never executed.
 */
export async function createUploadReviewSnapshot(files: readonly BundleFile[]): Promise<UploadReviewSnapshot> {
  const bundle = validateBundle({ format: 'pskills-bundle-v1', files });
  // Sort before applying the aggregate text budget so callers cannot change
  // which complete files receive text by reordering the upload.
  const orderedFiles = [...bundle.files].sort((left, right) => (
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  ));
  let exposedTextCharacters = 0;
  const snapshotFiles = [];
  for (const file of orderedFiles) {
    const bytes = decodeBase64(file.content);
    const digest = await digestBytes(bytes);
    const path = file.path;
    if (!isTextPath(path) || bytes.byteLength > MAX_UPLOAD_REVIEW_TEXT_CHARS) {
      snapshotFiles.push({
        path,
        kind: bytes.byteLength > MAX_UPLOAD_REVIEW_TEXT_CHARS ? 'oversize' as const : 'binary' as const,
        size: bytes.byteLength,
        digest,
      });
      continue;
    }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      // Valid UTF-8 is not necessarily safe reviewer text: classify embedded
      // NUL and unsupported controls as metadata-only instead of rejecting the
      // complete draft. LF/CR/tab remain valid and are preserved byte-for-byte.
      if (UNSUPPORTED_TEXT_CONTROL_CHARACTER.test(text)) {
        snapshotFiles.push({ path, kind: 'binary' as const, size: bytes.byteLength, digest });
        continue;
      }
      const characters = [...text].length;
      if (exposedTextCharacters + characters > MAX_UPLOAD_REVIEW_TOTAL_TEXT_CHARS) {
        // Whole-file fallback keeps the aggregate bound deterministic and
        // avoids silently truncating a reviewer's source text.
        snapshotFiles.push({ path, kind: 'oversize' as const, size: bytes.byteLength, digest });
        continue;
      }
      exposedTextCharacters += characters;
      snapshotFiles.push({ path, kind: 'text' as const, size: bytes.byteLength, digest, text });
    } catch {
      snapshotFiles.push({ path, kind: 'binary' as const, size: bytes.byteLength, digest });
    }
  }
  return { files: snapshotFiles };
}

function isTextPath(path: string): boolean {
  const basename = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (TEXT_FILENAMES.has(basename)) return true;
  const dot = basename.lastIndexOf('.');
  return dot >= 0 && TEXT_EXTENSIONS.has(basename.slice(dot));
}

function decodeBase64(value: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }
  return Uint8Array.from(Buffer.from(value, 'base64'));
}
