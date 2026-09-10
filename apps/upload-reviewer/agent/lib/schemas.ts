import { z } from 'zod';

const DIGEST = /^sha256:[0-9a-f]{64}$/u;

export const fileSchema = z.object({
  path: z.string().min(1).max(4_096),
  kind: z.enum(['text', 'binary', 'oversize']),
  size: z.number().int().nonnegative(),
  digest: z.string().regex(DIGEST),
  text: z.string().max(16_000).optional(),
}).strict();

export const prepareResponseSchema = z.object({
  status: z.enum(['prepared', 'already_completed', 'failed', 'stale']),
  jobId: z.string().min(1).max(256),
  draftId: z.string().min(1).max(256),
  draftRevision: z.number().int().positive(),
  contentDigest: z.string().regex(DIGEST),
  baseReleaseId: z.string().max(256).optional(),
  baseReleaseVersion: z.string().max(128).optional(),
  baseDigest: z.string().regex(DIGEST).optional(),
  policyRevision: z.string().min(1).max(256),
  model: z.string().min(1).max(256),
  reviewerRevision: z.string().min(1).max(128),
  files: z.array(fileSchema).max(2_000).optional(),
  leaseToken: z.string().min(1).max(256).optional(),
}).strict();

export const prepareOutputSchema = z.object({
  status: z.enum(['prepared', 'already_completed', 'failed', 'stale']),
  draftId: z.string().min(1).max(256).optional(),
  draftRevision: z.number().int().positive().optional(),
  contentDigest: z.string().regex(DIGEST).optional(),
  policyRevision: z.string().min(1).max(256).optional(),
  reviewerRevision: z.string().min(1).max(128).optional(),
  files: z.array(fileSchema).max(2_000),
}).strict();

export const findingSchema = z.object({
  severity: z.enum(['info', 'low', 'medium', 'high', 'critical']),
  category: z.string().min(1).max(128),
  title: z.string().min(1).max(256),
  summary: z.string().min(1).max(4_000),
  evidence: z.string().max(4_000).optional(),
  recommendation: z.string().max(4_000).optional(),
  path: z.string().min(1).max(4_096).optional(),
  line: z.number().int().positive().optional(),
}).strict();

export const submitInputSchema = z.object({
  findings: z.array(findingSchema).max(60),
}).strict();

export const submitOutputSchema = z.object({
  status: z.enum(['passed', 'already_completed', 'failed', 'stale']),
  resultId: z.string().min(1).max(256).optional(),
  findingCount: z.number().int().nonnegative().max(60),
}).strict();

export const failOutputSchema = z.object({
  status: z.literal('failed'),
  resultId: z.string().min(1).max(256).optional(),
}).strict();
