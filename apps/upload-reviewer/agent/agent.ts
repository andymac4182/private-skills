import { defineAgent, defineDynamic } from 'eve';
import { uploadReviewLanguageModel, uploadReviewModel } from './lib/config.js';

export default defineAgent({
  defaultTools: false,
  model: defineDynamic({
    events: {
      'session.started': () => uploadReviewModel(),
      'step.started': () => uploadReviewLanguageModel(),
    },
  }),
  reasoning: 'medium',
  limits: {
    maxInputTokensPerSession: 60_000,
    maxOutputTokensPerSession: 8_000,
    maxTokenCostUsdPerSession: 0.5,
    sessionTimeoutMs: 10 * 60 * 1_000,
  },
});
