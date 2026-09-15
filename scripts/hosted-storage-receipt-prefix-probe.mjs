#!/usr/bin/env node

/**
 * Read-only Vercel Blob preflight for the storage-receipt rehearsal.
 *
 * Run this through `vercel env run -e production --` from a linked private
 * Skills project. The token is consumed by @vercel/blob in process and is
 * never printed. This script has no upload, delete, copy, or empty-store path.
 */

import { randomUUID } from 'node:crypto';
import { list } from '@vercel/blob';

const storeId = 'store_C0EMhnU7DH3uSMaw';
const prefix = `rehearsal/tenant-runtime/${randomUUID()}/`;

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  process.stderr.write('hosted-storage-receipt-prefix-probe: BLOB_READ_WRITE_TOKEN is unavailable\n');
  process.exitCode = 2;
} else {
  try {
    const page = await list({ prefix, limit: 1 });
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      storeId,
      prefix,
      readOnly: true,
      mutationPerformed: false,
      matches: page.blobs.length,
      hasMore: page.hasMore === true,
      foldersReturned: page.folders?.length ?? 0,
      keysEmitted: false,
      credentialsEmitted: false,
    })}\n`);
  } catch {
    // Keep provider errors bounded and prevent SDK messages from becoming an
    // accidental credential or object-name channel in operator logs.
    process.stderr.write('hosted-storage-receipt-prefix-probe: read-only prefix listing failed\n');
    process.exitCode = 1;
  }
}
