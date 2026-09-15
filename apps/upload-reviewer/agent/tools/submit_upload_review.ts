import { defineTool } from 'eve/tools';
import { postUploadReviewerJson } from '../lib/api.js';
import { submitInputSchema, submitOutputSchema } from '../lib/schemas.js';
import { uploadReviewState } from '../lib/review-state.js';

export default defineTool({
  description: [
    'Submit bounded advisory findings for the prepared upload/edit draft snapshot.',
    'Use only paths and line numbers present in the prepared snapshot. This cannot publish, merge, install, execute, change policy, or grant scanner approval.',
    'Submit an empty findings array when no safe finding is supported.',
  ].join(' '),
  inputSchema: submitInputSchema,
  outputSchema: submitOutputSchema,
  async execute(input, ctx) {
    const current = uploadReviewState.get();
    if (current.status !== 'prepared' || !current.jobId || !current.leaseToken) {
      const status = current.status === 'completed'
        ? 'already_completed' as const
        : current.status === 'failed'
          ? 'failed' as const
          : 'stale' as const;
      return { status, findingCount: 0 };
    }
    if (current.submitCalls >= 1) throw new Error('submit_upload_review call budget exhausted');
    uploadReviewState.update((state) => ({ ...state, submitCalls: state.submitCalls + 1 }));
    const response = await postUploadReviewerJson(
      '/internal/upload-review/complete',
      {
        sessionId: ctx.session.id,
        jobId: current.jobId,
        leaseToken: current.leaseToken,
        findings: input.findings,
      },
      (value) => submitOutputSchema.parse(value),
      ctx.abortSignal,
      {
        session: ctx.session,
        binding: { sessionId: ctx.session.id, jobId: current.jobId },
      },
    );
    uploadReviewState.update((state) => ({
      ...state,
      status: response.status === 'passed' || response.status === 'already_completed' ? 'completed' : response.status,
      leaseToken: null,
      files: [],
    }));
    return response;
  },
});
