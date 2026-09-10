import type {
  OpenClawMetadataPreviewResult,
  OpenClawMetadataSnapshot,
} from '../../../packages/openclaw-adapter/src/index.ts';
import type { OpenClawRefreshResult } from '../../../packages/openclaw/src/index.ts';

/** Project both refresh and durable-metadata reads without dropping the server-selected profile. */
export function openClawConsumerRefreshResult(result: OpenClawRefreshResult): {
  kind: OpenClawMetadataPreviewResult['kind'];
  snapshot?: OpenClawMetadataSnapshot;
} {
  if (result.kind === 'rejected') return { kind: result.kind };
  const snapshot = result.snapshot;
  return {
    kind: result.kind,
    snapshot: {
      feed: {
        schemaVersion: snapshot.feed.schemaVersion,
        id: snapshot.feed.id,
        generatedAt: snapshot.feed.generatedAt,
        sequence: snapshot.feed.sequence,
        expiresAt: snapshot.feed.expiresAt,
        ...(snapshot.feed.description === undefined ? {} : { description: snapshot.feed.description }),
        entries: snapshot.feed.entries.map((entry) => ({
          type: entry.type,
          id: entry.id,
          title: entry.title,
          ...(entry.description === undefined ? {} : { description: entry.description }),
          ...(entry.icon === undefined ? {} : { icon: entry.icon }),
          version: entry.version,
          state: entry.state,
          ...(entry.featured === undefined ? {} : { featured: entry.featured }),
          ...(entry.featuredAt === undefined ? {} : { featuredAt: entry.featuredAt }),
          publisher: { ...entry.publisher },
          install: {
            candidates: entry.install.candidates.map((candidate) => ({
              sourceRef: candidate.sourceRef,
              package: candidate.package,
              version: candidate.version,
              integrity: candidate.integrity,
              ...(candidate.github === undefined ? {} : { github: { ...candidate.github } }),
            })),
          },
        })),
      },
      sha256: snapshot.sha256,
      etag: snapshot.etag,
      ...(snapshot.compatibilityProfile === undefined ? {} : { compatibilityProfile: snapshot.compatibilityProfile }),
      ...(snapshot.lastModified === undefined ? {} : { lastModified: snapshot.lastModified }),
      acceptedAt: snapshot.acceptedAt,
      sourceUrl: snapshot.sourceUrl,
    },
  };
}
