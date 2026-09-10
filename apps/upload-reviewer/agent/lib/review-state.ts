import { defineState } from 'eve/context';

export interface UploadReviewFile {
  path: string;
  kind: 'text' | 'binary' | 'oversize';
  size: number;
  digest: string;
  text?: string;
}

export interface UploadReviewSessionState {
  status: 'idle' | 'prepared' | 'completed' | 'failed' | 'stale';
  jobId: string | null;
  leaseToken: string | null;
  draftId: string | null;
  draftRevision: number | null;
  contentDigest: string | null;
  policyRevision: string | null;
  reviewerRevision: string | null;
  files: UploadReviewFile[];
  submitCalls: number;
}

export const uploadReviewState = defineState<UploadReviewSessionState>(
  'private-skills.upload-edit-review',
  () => ({
    status: 'idle',
    jobId: null,
    leaseToken: null,
    draftId: null,
    draftRevision: null,
    contentDigest: null,
    policyRevision: null,
    reviewerRevision: null,
    files: [],
    submitCalls: 0,
  }),
);
