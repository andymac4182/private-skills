import type { BundleFile } from '../../contracts/src/index.js';
import { digestBytes, validateBundle } from '../../storage/src/index.js';
import {
  MAX_UPLOAD_REVIEW_TEXT_CHARS,
  type UploadReviewSnapshot,
} from './index.js';

const TEXT_FILENAMES = new Set(['skill.md', 'readme', 'readme.md', 'license', 'license.md']);
const TEXT_EXTENSIONS = new Set([
  '.c', '.cc', '.cfg', '.conf', '.cpp', '.css', '.csv', '.go', '.h', '.hpp', '.html', '.ini',
  '.java', '.js', '.json', '.jsx', '.log', '.md', '.mjs', '.py', '.rs', '.sh', '.sql', '.toml',
  '.ts', '.tsx', '.txt', '.yaml', '.yml',
]);

/**
 * Convert a validated canonical draft bundle into the bounded reviewer view.
 * Only known text paths under the text limit receive decoded contents; every
 * other file is represented by digest/size metadata and is never executed.
 */
export async function createUploadReviewSnapshot(files: readonly BundleFile[]): Promise<UploadReviewSnapshot> {
  const bundle = validateBundle({ format: 'pskills-bundle-v1', files });
  const snapshotFiles = await Promise.all(bundle.files.map(async (file) => {
    const bytes = decodeBase64(file.content);
    const digest = await digestBytes(bytes);
    const path = file.path;
    if (!isTextPath(path) || bytes.byteLength > MAX_UPLOAD_REVIEW_TEXT_CHARS) {
      return {
        path,
        kind: bytes.byteLength > MAX_UPLOAD_REVIEW_TEXT_CHARS ? 'oversize' as const : 'binary' as const,
        size: bytes.byteLength,
        digest,
      };
    }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return { path, kind: 'text' as const, size: bytes.byteLength, digest, text };
    } catch {
      return { path, kind: 'binary' as const, size: bytes.byteLength, digest };
    }
  }));
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
