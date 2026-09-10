import { defineAgent, defineDynamic } from "eve";
import { assertBuilderEnabled, builderLanguageModel, builderModel } from "./lib/config.js";

export default defineAgent({
  defaultTools: false,
  model: defineDynamic({
    events: {
      "session.started": () => {
        assertBuilderEnabled();
        return builderModel();
      },
      "step.started": () => builderLanguageModel(),
    },
  }),
  reasoning: "medium",
  limits: {
    maxInputTokensPerSession: 120_000,
    maxOutputTokensPerSession: 16_000,
    maxTokenCostUsdPerSession: 0.75,
    sessionTimeoutMs: 4 * 60 * 60 * 1_000,
  },
});
