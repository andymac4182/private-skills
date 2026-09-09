import {
  SkillsDirectoryError,
  type ListSkillsOptions,
  type SkillListResponse,
  type SkillSourceType,
  type SkillView,
  type SkillsDirectoryErrorCode,
  type V1Skill,
} from './types.js';

/**
 * Limits for a metadata-only catalog traversal.  These limits apply to the
 * result retained by this helper as well as to the number of upstream pages
 * requested.  A caller can choose a smaller bound, but cannot make a run
 * unbounded by passing Infinity or a non-finite value.
 */
export interface SkillsEnumerationLimits {
  maxPages: number;
  maxRows: number;
  maxBytes: number;
  timeoutMs: number;
}

export const DEFAULT_SKILLS_ENUMERATION_LIMITS: Readonly<SkillsEnumerationLimits> = Object.freeze({
  maxPages: 64,
  maxRows: 32_000,
  maxBytes: 8 * 1024 * 1024,
  timeoutMs: 30_000,
});

const ENUMERATION_MAX_LIMITS: Readonly<SkillsEnumerationLimits> = Object.freeze({
  maxPages: 1_000,
  maxRows: 1_000_000,
  maxBytes: 64 * 1024 * 1024,
  timeoutMs: 120_000,
});

export type SkillsEnumerationStatus = 'complete' | 'truncated' | 'drifted' | 'unavailable';

export type SkillsEnumerationReason =
  | 'page_limit'
  | 'row_limit'
  | 'byte_limit'
  | 'timeout'
  | 'cancelled'
  | 'page_mismatch'
  | 'repeated_page'
  | 'total_changed'
  | 'per_page_changed'
  | 'row_bound_exceeded'
  | 'empty_continuation'
  | 'observed_total_mismatch'
  | 'conflicting_duplicate'
  | 'malformed_page'
  | 'upstream_error';

/** A bounded, sanitized account of one page returned by the directory. */
export interface SkillsEnumerationPage {
  requestedPage: number;
  responsePage: number | null;
  perPage: number | null;
  returnedRows: number;
  hasMore: boolean | null;
  reportedTotal: number | null;
  bytes: number;
}

/** Count and location evidence for a duplicate complete external ID. */
export interface SkillsEnumerationDuplicate {
  id: string;
  /** Total retained occurrences of this ID. */
  count: number;
  /** Number of retained occurrences after the first. */
  duplicateRows: number;
  pages: number[];
}

/**
 * Bounded evidence that one complete ID was returned with different
 * normalized metadata. The later row is retained here instead of being
 * silently discarded from the coverage result.
 */
export interface SkillsEnumerationConflict {
  id: string;
  firstPage: number;
  conflictingPage: number;
  fields: string[];
  firstRow: V1Skill;
  conflictingRow: V1Skill;
}

export interface SkillsEnumerationReconciliation {
  /** The first page's declared total, or null before a valid page is seen. */
  reportedTotal: number | null;
  /** Rows received from valid, identity-matched pages, including omitted rows. */
  observedRows: number;
  /** Rows retained in the bounded result after ID de-duplication. */
  uniqueRows: number;
  /** Repeated retained rows (`observed retained rows - uniqueRows`). */
  duplicateRows: number;
  /** Number of duplicate occurrences with conflicting normalized metadata. */
  conflicts: number;
  /** Rows received but not retained because a bound ended the run. */
  rowsOmitted: number;
  /** True only when all received rows were retained and total reconciliation is valid. */
  complete: boolean;
  /** Whether observedRows equals the declared total when a total is available. */
  matchesReportedTotal: boolean | null;
}

/**
 * Result of a complete or bounded metadata traversal.  `rows` and
 * `uniqueIds` contain first-seen rows only; duplicate evidence is retained in
 * `duplicates`/`duplicateCounts` and in the reconciliation fields.
 */
export interface SkillsEnumerationResult {
  status: SkillsEnumerationStatus;
  complete: boolean;
  truncated: boolean;
  drifted: boolean;
  reason: SkillsEnumerationReason | null;
  errorCode: SkillsDirectoryErrorCode | null;
  view: SkillView;
  perPage: number;
  rows: V1Skill[];
  uniqueIds: string[];
  /** Compatibility aliases for coverage verifiers that use declared/observed terminology. */
  totalDeclared: number | null;
  totalObserved: number;
  duplicates: SkillsEnumerationDuplicate[];
  duplicateIds: string[];
  /** Total retained occurrences for each duplicated complete ID. */
  duplicateCounts: Record<string, number>;
  duplicateRows: number;
  conflicts: SkillsEnumerationConflict[];
  conflictIds: string[];
  conflictingRows: number;
  observedRows: number;
  receivedRows: number;
  rowsOmitted: number;
  observedBytes: number;
  retainedBytes: number;
  pagesFetched: number;
  pages: SkillsEnumerationPage[];
  reportedTotal: number | null;
  sourceTypeCounts: Record<SkillSourceType, number>;
  reconciliation: SkillsEnumerationReconciliation;
  /** This helper never calls detail/source endpoints or writes artifacts. */
  metadataOnly: true;
  detailRequests: 0;
  artifactRequests: 0;
  mutatingRequests: 0;
  mutatingRoutes: string[];
}

/** Small structural seam so tests and server adapters can inject the client. */
export interface SkillsEnumerationClient {
  list(options?: ListSkillsOptions): Promise<SkillListResponse>;
}

export interface EnumerateSkillsOptions {
  view?: SkillView;
  /** Zero-based page size sent to every list request. */
  perPage?: number;
  signal?: AbortSignal;
  limits?: Partial<SkillsEnumerationLimits>;
}

interface MutableState {
  status: SkillsEnumerationStatus;
  reason: SkillsEnumerationReason | null;
  errorCode: SkillsDirectoryErrorCode | null;
  reportedTotal: number | null;
  receivedRows: number;
  observedRows: number;
  rowsOmitted: number;
  observedBytes: number;
  retainedBytes: number;
  pagesFetched: number;
  pages: SkillsEnumerationPage[];
  rows: V1Skill[];
  uniqueIds: string[];
  duplicates: Map<string, { count: number; pages: Set<number> }>;
  conflicts: SkillsEnumerationConflict[];
  conflictIds: Set<string>;
  firstRows: Map<string, V1Skill>;
  firstPageById: Map<string, number>;
  sourceTypeCounts: Record<SkillSourceType, number>;
  seenPages: Set<number>;
}

type ListOutcome =
  | { kind: 'value'; value: SkillListResponse }
  | { kind: 'timeout' }
  | { kind: 'cancelled' }
  | { kind: 'error'; error: unknown };

/**
 * Walk list pages from zero until the API declares completion or a bound or
 * pagination inconsistency prevents a trustworthy snapshot.  The helper is
 * intentionally metadata-only: it never calls `detail`, resolves source
 * bytes, or writes to storage.
 */
export async function enumerateSkills(
  client: SkillsEnumerationClient,
  options: EnumerateSkillsOptions = {},
): Promise<SkillsEnumerationResult> {
  const view = normalizeView(options.view);
  const perPage = normalizeBoundedInteger(options.perPage ?? 500, 1, 500, 'perPage');
  const limits = normalizeEnumerationLimits(options.limits);
  const state = createState(view, perPage);
  const deadline = Date.now() + limits.timeoutMs;
  const callerSignal = options.signal;

  if (callerSignal?.aborted) {
    state.status = 'truncated';
    state.reason = 'cancelled';
    return finalize(state, view, perPage);
  }

  let requestedPage = 0;
  let lastHasMore = true;

  while (lastHasMore) {
    if (callerSignal?.aborted) {
      state.status = 'truncated';
      state.reason = 'cancelled';
      break;
    }
    if (state.pagesFetched >= limits.maxPages) {
      state.status = 'truncated';
      state.reason = 'page_limit';
      break;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      state.status = 'truncated';
      state.reason = 'timeout';
      break;
    }

    const outcome = await boundedList(client, {
      view,
      page: requestedPage,
      perPage,
      signal: callerSignal,
    }, remainingMs);

    if (outcome.kind === 'cancelled') {
      state.status = 'truncated';
      state.reason = 'cancelled';
      break;
    }
    if (outcome.kind === 'timeout') {
      state.status = 'truncated';
      state.reason = 'timeout';
      break;
    }
    if (outcome.kind === 'error') {
      state.status = 'unavailable';
      state.reason = 'upstream_error';
      state.errorCode = outcome.error instanceof SkillsDirectoryError
        ? outcome.error.code
        : 'unavailable';
      break;
    }

    const page = outcome.value;
    const pageBytes = byteLength(page);
    const pagination = page.pagination;
    const returnedRows = Array.isArray(page.data) ? page.data.length : 0;
    const pageMetadata: SkillsEnumerationPage = {
      requestedPage,
      responsePage: isFiniteNonNegativeInteger(pagination?.page) ? pagination.page : null,
      perPage: isFinitePositiveInteger(pagination?.perPage) ? pagination.perPage : null,
      returnedRows,
      hasMore: typeof pagination?.hasMore === 'boolean' ? pagination.hasMore : null,
      reportedTotal: isFiniteNonNegativeInteger(pagination?.total) ? pagination.total : null,
      bytes: pageBytes,
    };

    state.pages.push(pageMetadata);
    state.pagesFetched += 1;
    state.observedBytes += pageBytes;

    if (!isValidListResponse(page)) {
      state.status = 'unavailable';
      state.reason = 'malformed_page';
      state.errorCode = 'invalid_response';
      state.rowsOmitted += returnedRows;
      break;
    }

    const { pagination: validPagination } = page;
    state.receivedRows += page.data.length;

    if (state.seenPages.has(validPagination.page)) {
      state.status = 'drifted';
      state.reason = 'repeated_page';
      state.rowsOmitted += page.data.length;
      break;
    }
    state.seenPages.add(validPagination.page);

    if (validPagination.page !== requestedPage) {
      state.status = 'drifted';
      state.reason = 'page_mismatch';
      state.rowsOmitted += page.data.length;
      break;
    }
    if (state.reportedTotal === null) {
      state.reportedTotal = validPagination.total;
    } else if (validPagination.total !== state.reportedTotal) {
      state.status = 'drifted';
      state.reason = 'total_changed';
      state.rowsOmitted += page.data.length;
      break;
    }
    if (validPagination.perPage !== perPage) {
      state.status = 'drifted';
      state.reason = 'per_page_changed';
      state.rowsOmitted += page.data.length;
      break;
    }
    if (page.data.length > validPagination.perPage) {
      state.status = 'drifted';
      state.reason = 'row_bound_exceeded';
      state.rowsOmitted += page.data.length;
      break;
    }

    const retainedRowsBeforePage = state.observedRows - state.rowsOmitted;
    state.observedRows += page.data.length;
    lastHasMore = validPagination.hasMore;

    if (page.data.length === 0 && lastHasMore) {
      state.status = 'drifted';
      state.reason = 'empty_continuation';
      break;
    }

    if (state.retainedBytes + pageBytes > limits.maxBytes) {
      state.status = 'truncated';
      state.reason = 'byte_limit';
      state.rowsOmitted += page.data.length;
      break;
    }

    const remainingRows = limits.maxRows - retainedRowsBeforePage;
    const rowsToRetain = Math.min(page.data.length, Math.max(0, remainingRows));
    for (let index = 0; index < rowsToRetain; index += 1) {
      retainRow(state, page.data[index]!, validPagination.page);
    }
    state.retainedBytes += pageBytes;
    if (rowsToRetain < page.data.length) {
      state.rowsOmitted += page.data.length - rowsToRetain;
      state.status = 'truncated';
      state.reason = 'row_limit';
      break;
    }

    if (state.conflicts.length > 0) {
      state.status = 'drifted';
      state.reason = 'conflicting_duplicate';
      break;
    }

    if (!lastHasMore) {
      if (state.reportedTotal !== state.observedRows) {
        state.status = 'drifted';
        state.reason = 'observed_total_mismatch';
      } else {
        state.status = 'complete';
        state.reason = null;
      }
      break;
    }

    if (state.observedRows - state.rowsOmitted >= limits.maxRows) {
      state.status = 'truncated';
      state.reason = 'row_limit';
      break;
    }

    if (state.pagesFetched >= limits.maxPages) {
      state.status = 'truncated';
      state.reason = 'page_limit';
      break;
    }
    requestedPage += 1;
  }

  return finalize(state, view, perPage);
}

/** Alias for callers that prefer the directory-qualified name. */
export const enumerateDirectorySkills = enumerateSkills;

function createState(_view: SkillView, _perPage: number): MutableState {
  return {
    status: 'truncated',
    reason: 'timeout',
    errorCode: null,
    reportedTotal: null,
    receivedRows: 0,
    observedRows: 0,
    rowsOmitted: 0,
    observedBytes: 0,
    retainedBytes: 0,
    pagesFetched: 0,
    pages: [],
    rows: [],
    uniqueIds: [],
    duplicates: new Map(),
    conflicts: [],
    conflictIds: new Set(),
    firstRows: new Map(),
    firstPageById: new Map(),
    sourceTypeCounts: { github: 0, 'well-known': 0 },
    seenPages: new Set(),
  };
}

function retainRow(state: MutableState, row: V1Skill, page: number): void {
  const existing = state.duplicates.get(row.id);
  if (existing) {
    existing.count += 1;
    existing.pages.add(page);
    const firstRow = state.firstRows.get(row.id);
    const firstPage = state.firstPageById.get(row.id);
    if (firstRow && firstPage !== undefined) {
      const fields = differingSkillFields(firstRow, row);
      if (fields.length > 0) {
        state.conflicts.push({
          id: row.id,
          firstPage,
          conflictingPage: page,
          fields,
          firstRow,
          conflictingRow: row,
        });
        state.conflictIds.add(row.id);
      }
    }
    return;
  }
  if (state.firstRows.has(row.id)) {
    const firstPage = state.firstPageById.get(row.id);
    state.duplicates.set(row.id, {
      count: 2,
      pages: new Set(firstPage === undefined ? [page] : [firstPage, page]),
    });
    const firstRow = state.firstRows.get(row.id);
    if (firstRow && firstPage !== undefined) {
      const fields = differingSkillFields(firstRow, row);
      if (fields.length > 0) {
        state.conflicts.push({
          id: row.id,
          firstPage,
          conflictingPage: page,
          fields,
          firstRow,
          conflictingRow: row,
        });
        state.conflictIds.add(row.id);
      }
    }
    return;
  }
  state.firstRows.set(row.id, row);
  state.firstPageById.set(row.id, page);
  state.rows.push(row);
  state.uniqueIds.push(row.id);
  state.sourceTypeCounts[row.sourceType] += 1;
}

const SKILL_COMPARISON_FIELDS: ReadonlyArray<keyof V1Skill> = [
  'id',
  'slug',
  'name',
  'source',
  'installs',
  'sourceType',
  'installUrl',
  'url',
  'isDuplicate',
  'installsYesterday',
  'change',
];

function differingSkillFields(first: V1Skill, duplicate: V1Skill): string[] {
  return SKILL_COMPARISON_FIELDS.filter((field) => !Object.is(first[field], duplicate[field]));
}

function finalize(state: MutableState, view: SkillView, perPage: number): SkillsEnumerationResult {
  const duplicates = [...state.duplicates.entries()]
    .map(([id, value]) => ({
      id,
      count: value.count,
      duplicateRows: value.count - 1,
      pages: [...value.pages].sort((left, right) => left - right),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const duplicateRows = duplicates.reduce((total, duplicate) => total + duplicate.duplicateRows, 0);
  const conflicts = state.conflicts.slice();
  const conflictIds = [...state.conflictIds].sort();
  const complete = state.status === 'complete'
    && state.rowsOmitted === 0
    && conflicts.length === 0
    && state.reportedTotal !== null
    && state.observedRows === state.reportedTotal;
  const matchesReportedTotal = state.reportedTotal === null
    ? null
    : state.observedRows === state.reportedTotal;
  const reconciliation: SkillsEnumerationReconciliation = {
    reportedTotal: state.reportedTotal,
    observedRows: state.observedRows,
    uniqueRows: state.rows.length,
    duplicateRows,
    conflicts: conflicts.length,
    rowsOmitted: state.rowsOmitted,
    complete,
    matchesReportedTotal,
  };
  const duplicateCounts: Record<string, number> = {};
  for (const duplicate of duplicates) duplicateCounts[duplicate.id] = duplicate.count;

  return {
    status: complete ? 'complete' : state.status,
    complete,
    truncated: state.status === 'truncated',
    drifted: state.status === 'drifted',
    reason: complete ? null : state.reason,
    errorCode: state.errorCode,
    view,
    perPage,
    rows: state.rows,
    uniqueIds: state.uniqueIds,
    totalDeclared: state.reportedTotal,
    totalObserved: state.observedRows,
    duplicates,
    duplicateIds: duplicates.map((duplicate) => duplicate.id),
    duplicateCounts,
    duplicateRows,
    conflicts,
    conflictIds,
    conflictingRows: conflicts.length,
    observedRows: state.observedRows,
    receivedRows: state.receivedRows,
    rowsOmitted: state.rowsOmitted,
    observedBytes: state.observedBytes,
    retainedBytes: state.retainedBytes,
    pagesFetched: state.pagesFetched,
    pages: state.pages,
    reportedTotal: state.reportedTotal,
    sourceTypeCounts: { ...state.sourceTypeCounts },
    reconciliation,
    metadataOnly: true,
    detailRequests: 0,
    artifactRequests: 0,
    mutatingRequests: 0,
    mutatingRoutes: [],
  };
}

async function boundedList(
  client: SkillsEnumerationClient,
  options: ListSkillsOptions,
  timeoutMs: number,
): Promise<ListOutcome> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: () => void = () => undefined;
  let callerAborted = false;
  const callerSignal = options.signal;

  const request = Promise.resolve()
    .then(() => client.list({ ...options, signal: controller.signal }))
    .then(
      (value): ListOutcome => ({ kind: 'value', value }),
      (error): ListOutcome => ({ kind: 'error', error }),
    );

  const cancellation = new Promise<ListOutcome>((resolve) => {
    if (!callerSignal) return;
    const onAbort = () => {
      callerAborted = true;
      controller.abort();
      resolve({ kind: 'cancelled' });
    };
    if (callerSignal.aborted) {
      onAbort();
      return;
    }
    callerSignal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => callerSignal.removeEventListener('abort', onAbort);
  });

  const deadline = new Promise<ListOutcome>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: 'timeout' });
    }, Math.max(1, timeoutMs));
  });

  try {
    const outcome = await Promise.race([request, cancellation, deadline]);
    if (callerAborted && outcome.kind === 'error') return { kind: 'cancelled' };
    return outcome;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    removeAbortListener();
  }
}

function normalizeEnumerationLimits(
  requested: Partial<SkillsEnumerationLimits> | undefined,
): SkillsEnumerationLimits {
  const limits = {
    ...DEFAULT_SKILLS_ENUMERATION_LIMITS,
    ...(requested ?? {}),
  };
  for (const key of ['maxPages', 'maxRows', 'maxBytes', 'timeoutMs'] as const) {
    const value = limits[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > ENUMERATION_MAX_LIMITS[key]) {
      throw new SkillsDirectoryError('invalid_input', `Invalid skills enumeration limit: ${key}`);
    }
  }
  return limits;
}

function normalizeView(view: SkillView | undefined): SkillView {
  const normalized = view ?? 'all-time';
  if (normalized !== 'all-time' && normalized !== 'trending' && normalized !== 'hot') {
    throw new SkillsDirectoryError('invalid_input', 'Invalid skills enumeration view');
  }
  return normalized;
}

function normalizeBoundedInteger(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new SkillsDirectoryError('invalid_input', `Invalid skills enumeration option: ${field}`);
  }
  return value;
}

function isFiniteNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isFinitePositiveInteger(value: unknown): value is number {
  return isFiniteNonNegativeInteger(value) && value > 0;
}

function isValidListResponse(value: unknown): value is SkillListResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as { data?: unknown; pagination?: unknown };
  if (!Array.isArray(record.data) || typeof record.pagination !== 'object' || record.pagination === null || Array.isArray(record.pagination)) return false;
  const pagination = record.pagination as Partial<SkillListResponse['pagination']>;
  if (!isFiniteNonNegativeInteger(pagination.page)
    || !isFinitePositiveInteger(pagination.perPage)
    || pagination.perPage > 500
    || !isFiniteNonNegativeInteger(pagination.total)
    || typeof pagination.hasMore !== 'boolean') return false;
  return record.data.every((row) => isSkillRow(row));
}

function isSkillRow(value: unknown): value is V1Skill {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Partial<V1Skill>;
  return typeof row.id === 'string'
    && row.id.length > 0
    && typeof row.slug === 'string'
    && typeof row.name === 'string'
    && typeof row.source === 'string'
    && isFiniteNonNegativeInteger(row.installs)
    && (row.sourceType === 'github' || row.sourceType === 'well-known')
    && (row.installUrl === null || typeof row.installUrl === 'string')
    && typeof row.url === 'string';
}

function byteLength(value: unknown): number {
  try {
    const encoded = new TextEncoder().encode(JSON.stringify(value));
    return encoded.byteLength;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}
