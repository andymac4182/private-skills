import { defineAgent, defineDynamic } from "eve";
import { reviewLanguageModel, reviewModel } from "./lib/config.js";

export default defineAgent({
  defaultTools: false,
  model: defineDynamic({
    events: {
      "session.started": () => reviewModel(),
      "step.started": () => reviewLanguageModel(),
    },
  }),
  reasoning: "medium",
  limits: {
    maxInputTokensPerSession: 100_000,
    maxOutputTokensPerSession: 10_000,
    maxTokenCostUsdPerSession: 0.5,
    sessionTimeoutMs: 10 * 60 * 1_000,
  },
});
