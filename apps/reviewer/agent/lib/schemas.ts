import { z } from "zod";

const DIGEST = /^sha256:[0-9a-f]{64}$/;

export const candidateSchema = z.object({
  resourceId: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  version: z.string().min(1).max(128),
  artifactDigest: z.string().regex(DIGEST),
  description: z.string().max(2_000),
  text: z.string().max(8_000),
}).strict();

export const prepareResponseSchema = z.object({
  runId: z.string().min(1).max(256).optional(),
  leaseToken: z.string().min(1).max(512).optional(),
  candidates: z.array(candidateSchema).max(60),
  alreadyCompleted: z.boolean().optional(),
}).strict();

const explanationSchema = z.string().max(4_000);
const evidenceListSchema = z.array(z.string().min(1).max(2_000)).min(1).max(32);

const proposalSchema = z.object({
  skillIds: z.array(z.string().min(1).max(256)).min(2).max(60),
  title: z.string().min(1).max(256),
  rationale: explanationSchema,
  overlap: evidenceListSchema,
  differences: evidenceListSchema,
  mergePlan: evidenceListSchema,
  similarity: z.number().finite().min(0).max(1),
}).strict().superRefine((proposal, context) => {
  for (const field of ["overlap", "differences", "mergePlan"] as const) {
    const joined = proposal[field].map((line) => `- ${line}`).join("\n");
    if (joined.length > 4_000) {
      context.addIssue({
        code: "too_big",
        maximum: 4_000,
        origin: "string",
        inclusive: true,
        path: [field],
        message: `${field} exceeds the review persistence limit`,
      });
    }
  }
});

export const submitInputSchema = z.object({
  summary: z.string().min(1).max(8_000),
  suggestions: z.array(proposalSchema).max(60),
}).strict();

export const prepareOutputSchema = z.object({
  status: z.enum(["prepared", "no_candidates", "already_completed"]),
  candidates: z.array(candidateSchema).max(60),
}).strict();

export const submitOutputSchema = z.object({
  status: z.enum(["completed", "already_completed", "not_prepared"]),
  suggestionsRecorded: z.number().int().min(0).max(60),
}).strict();
