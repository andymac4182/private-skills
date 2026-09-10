const MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/iu;

export const DEFAULT_UPLOAD_REVIEW_MODEL = 'openai/gpt-5.5';

export function resolveUploadReviewModel(environment: Record<string, string | undefined>): string {
  const value = environment.PSKILLS_UPLOAD_REVIEW_MODEL?.trim() || DEFAULT_UPLOAD_REVIEW_MODEL;
  if (value.length > 256 || !MODEL_ID.test(value)) throw new Error('PSKILLS_UPLOAD_REVIEW_MODEL is invalid');
  return value;
}

export function resolveUploadReviewRevision(environment: Record<string, string | undefined>): string {
  const value = environment.PSKILLS_UPLOAD_REVIEW_REVIEWER_REVISION?.trim() || 'upload-review-v1';
  if (value.length === 0 || value.length > 128 || /[\u0000-\u0020]/u.test(value)) {
    throw new Error('PSKILLS_UPLOAD_REVIEW_REVIEWER_REVISION is invalid');
  }
  return value;
}
