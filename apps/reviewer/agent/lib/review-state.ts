import { defineState } from "eve/context";

export interface ReviewCandidate {
  resourceId: string;
  name: string;
  version: string;
  // The response schema enforces the sha256 form. Keep this as a plain string
  // at the state boundary because zod's inferred output deliberately does not
  // carry a template-literal brand through Eve's durable serializer.
  artifactDigest: string;
  description: string;
  text: string;
}

export interface ReviewSessionState {
  status: "idle" | "prepared" | "completed";
  runId: string | null;
  leaseToken: string | null;
  candidates: ReviewCandidate[];
  prepareCalls: number;
  submitCalls: number;
}

export const reviewState = defineState<ReviewSessionState>(
  "private-skills.common-skill-review",
  () => ({
    status: "idle",
    runId: null,
    leaseToken: null,
    candidates: [],
    prepareCalls: 0,
    submitCalls: 0,
  }),
);
