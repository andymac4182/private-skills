import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type MutableRefObject, type ReactNode } from 'react'
import { useBlocker } from '@tanstack/react-router'
import { api, ApiError } from '../lib/api'
import { createSkillBuilderAdapter } from '../lib/builder'
import { formatBytes, shortDigest } from '../lib/format'
import type { DraftFileMetadata, DraftFileReference, DraftFileResponseEntry, DraftFileUpdate, DraftView, ReleaseFilePreviewState, ReleaseFileView, SkillBundle } from '../lib/types'
import { Badge, Button, ErrorState, LoadingState, Notice } from './Primitives'
import type { DraftSurfaceEntry, DraftSurfaceHandle } from './PierreDraftSurface'
import { DraftReviewPanel } from './DraftReviewPanel'
import { SkillBuilderPanel } from './SkillBuilderPanel'

const PierreDraftSurface = lazy(() => import('./PierreDraftSurface').then((module) => ({ default: module.PierreDraftSurface })))

interface DraftEditorProps {
  resourceId: string
  baseDigest: `sha256:${string}`
  baseVersion: string
  initialDraft?: DraftView
  resumeDraftId?: string
  closeRequest?: number
  onClose: () => void
  onDraftChange?: (draft: DraftView) => void
  onDirtyChange?: (dirty: boolean) => void
}

type DraftFile = SkillBundle['files'][number]
export type DraftWorkingFile = DraftFileMetadata & { content?: string; previewState?: ReleaseFilePreviewState; dirty?: boolean }
type WorkspaceTab = 'files' | 'build' | 'review'
const WORKSPACE_TABS: readonly WorkspaceTab[] = ['files', 'build', 'review']
type DraftFileLike = { path: string; content?: string; size?: number; previewState?: ReleaseFilePreviewState }
type ReleaseBaselineEntry = Pick<ReleaseFileView, 'path' | 'size' | 'previewState' | 'executable'> & { contentDigest?: `sha256:${string}`; contents?: string }
interface ImmutableReleaseBaseline { entries: ReleaseBaselineEntry[]; files: DraftFile[] }
type DraftOperation = { draftId: string; revision: number; version?: string; payloadFingerprint: string; key: string }
interface DraftPersistence { draftId?: string; createKey: string }

/** Must match the server's bounded release text preview contract. */
export const MAX_TEXT_PREVIEW_BYTES = 256 * 1024
const TEXT_EXTENSIONS = new Set(['c', 'cc', 'cfg', 'conf', 'cpp', 'css', 'csv', 'go', 'h', 'hpp', 'html', 'ini', 'java', 'js', 'json', 'jsx', 'md', 'mjs', 'mts', 'py', 'rs', 'sh', 'sql', 'toml', 'ts', 'tsx', 'txt', 'xml', 'yaml', 'yml'])
const BINARY_EXTENSIONS = new Set(['7z', 'avi', 'bin', 'bmp', 'class', 'dll', 'doc', 'docx', 'gif', 'gz', 'ico', 'jar', 'jpeg', 'jpg', 'mp3', 'mp4', 'pdf', 'png', 'so', 'tar', 'wasm', 'webp', 'woff', 'woff2', 'zip'])
const TEXT_FILENAMES = new Set(['.editorconfig', '.gitignore', '.npmignore', 'dockerfile', 'license', 'makefile', 'readme'])
const DRAFT_STORAGE_PREFIX = 'private-skills:draft:'

function workspaceElementId(value: string, suffix: string): string {
  const safeValue = value.replace(/[^a-zA-Z0-9_-]/g, '-') || 'editor'
  return `draft-workspace-${safeValue}-${suffix}`
}

function idempotencyKey(prefix: string): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `web-${prefix}-${random}`
}

function encodeBase64Text(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

interface DigestResult { digest: `sha256:${string}` | null; size: number | null }
interface DigestTask { content: string; resolve: (result: DigestResult) => void }
const digestCache = new Map<string, Promise<DigestResult>>()
const digestQueue: DigestTask[] = []
let activeDigestTasks = 0
const MAX_DIGEST_CACHE = 512
const MAX_ACTIVE_DIGESTS = 8

function decodeBase64Bytes(value: string): Uint8Array | null {
  try {
    const binary = atob(value)
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    return null
  }
}

async function digestBytes(content: string): Promise<DigestResult> {
  const bytes = decodeBase64Bytes(content)
  if (!bytes) return { digest: null, size: null }
  const cryptoApi = typeof globalThis.crypto === 'undefined' ? undefined : globalThis.crypto
  if (!cryptoApi?.subtle) return { digest: null, size: bytes.byteLength }
  try {
    const digest = await cryptoApi.subtle.digest('SHA-256', bytes as unknown as BufferSource)
    return { digest: `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`, size: bytes.byteLength }
  } catch {
    return { digest: null, size: bytes.byteLength }
  }
}

function pumpDigestQueue(): void {
  while (activeDigestTasks < MAX_ACTIVE_DIGESTS && digestQueue.length > 0) {
    const task = digestQueue.shift()
    if (!task) return
    activeDigestTasks += 1
    void digestBytes(task.content).then(task.resolve).finally(() => {
      activeDigestTasks -= 1
      pumpDigestQueue()
    })
  }
}

function digestForContent(content: string): Promise<DigestResult> {
  const cached = digestCache.get(content)
  if (cached) return cached
  const promise = new Promise<DigestResult>((resolve) => { digestQueue.push({ content, resolve }); pumpDigestQueue() })
  if (digestCache.size >= MAX_DIGEST_CACHE) {
    const oldest = digestCache.keys().next().value
    if (typeof oldest === 'string') digestCache.delete(oldest)
  }
  digestCache.set(content, promise)
  return promise
}

const draftFileCache = new Map<string, DraftWorkingFile>()
const MAX_DRAFT_FILE_CACHE = 128

function draftFileCacheKey(draftId: string, revision: number, digest: string, path: string): string {
  return `${draftId}\u0000${revision}\u0000${digest}\u0000${path}`
}

async function workingFileFromResponse(entry: DraftFileResponseEntry): Promise<DraftWorkingFile> {
  if (entry.previewState === 'text' && entry.content === undefined) throw new Error('The registry did not return the bounded text preview.')
  if (entry.content === undefined || entry.previewState !== 'text') {
    const { content: _content, ...metadata } = entry
    return { ...metadata, dirty: false }
  }
  const result = await digestForContent(entry.content)
  if (result.digest !== entry.digest || result.size !== entry.size) throw new Error('The selected draft file failed its digest check.')
  return { ...entry, dirty: false }
}

function cacheDraftFile(key: string, file: DraftWorkingFile): void {
  if (draftFileCache.size >= MAX_DRAFT_FILE_CACHE) {
    const oldest = draftFileCache.keys().next().value
    if (typeof oldest === 'string') draftFileCache.delete(oldest)
  }
  draftFileCache.set(key, { ...file })
}

function extensionFor(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  const index = name.lastIndexOf('.')
  return index > 0 ? name.slice(index + 1) : ''
}

function isBinaryPath(path: string): boolean {
  return BINARY_EXTENSIONS.has(extensionFor(path))
}

function isSupportedTextPath(path: string): boolean {
  const basename = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  return TEXT_FILENAMES.has(basename) || TEXT_EXTENSIONS.has(extensionFor(path))
}

function validUtf8(bytes: Uint8Array): boolean {
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const chunkSize = 64 * 1024
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) decoder.decode(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength)), { stream: true })
    decoder.decode()
    return true
  } catch {
    return false
  }
}

export interface DraftFilePreview {
  state: ReleaseFilePreviewState
  size: number | null
  text: string | null
}

const previewCache = new Map<string, DraftFilePreview>()
const MAX_PREVIEW_CACHE = 256

export function inspectDraftFile(file: DraftFileLike | null): DraftFilePreview | null {
  if (!file) return null
  if (typeof file.content !== 'string') {
    const size = file.size ?? null
    const inferredState = file.previewState ?? (size !== null && size > MAX_TEXT_PREVIEW_BYTES
      ? (isSupportedTextPath(file.path) ? 'oversize' : 'unsupported')
      : isBinaryPath(file.path) ? 'binary' : isSupportedTextPath(file.path) ? 'text' : 'unsupported')
    return { state: inferredState, size, text: null }
  }
  const cacheKey = `${file.path}\u0000${file.content}`
  const cached = previewCache.get(cacheKey)
  if (cached) return cached
  const bytes = decodeBase64Bytes(file.content)
  const size = bytes?.byteLength ?? null
  let preview: DraftFilePreview
  if (!bytes || isBinaryPath(file.path) || bytes.includes(0)) {
    preview = { state: 'binary', size, text: null }
  } else if (size !== null && size > MAX_TEXT_PREVIEW_BYTES) {
    const supported = isSupportedTextPath(file.path)
    preview = !validUtf8(bytes) ? { state: 'binary', size, text: null } : { state: supported ? 'oversize' : 'unsupported', size, text: null }
  } else {
    let text: string | null = null
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { text = null }
    if (text === null) preview = { state: 'binary', size, text: null }
    else if (!isSupportedTextPath(file.path)) preview = { state: 'unsupported', size, text: null }
    else preview = { state: 'text', size, text }
  }
  if (previewCache.size >= MAX_PREVIEW_CACHE) {
    const oldest = previewCache.keys().next().value
    if (typeof oldest === 'string') previewCache.delete(oldest)
  }
  previewCache.set(cacheKey, preview)
  return preview
}

function previewLabel(state: ReleaseFilePreviewState | null): string {
  if (state === 'oversize') return 'Too large to preview'
  if (state === 'binary') return 'Binary file'
  if (state === 'unsupported') return 'Unsupported preview'
  if (state === 'text') return 'Metadata only'
  return 'No preview'
}

function previewReason(state: ReleaseFilePreviewState | null): string {
  if (state === 'oversize') return `Text previews are limited to ${formatBytes(MAX_TEXT_PREVIEW_BYTES)}.`
  if (state === 'binary') return 'Binary files remain available in the release but are not opened as text.'
  if (state === 'unsupported') return 'This path is not an allowed text preview type.'
  if (state === 'text') return 'The file is available as text after its release baseline is loaded.'
  return 'This file is available in the release manifest, but no text preview is available.'
}

function editableText(file: DraftFileLike | null): string | null {
  return inspectDraftFile(file)?.text ?? null
}

function cloneFiles(files: DraftFile[]): DraftFile[] {
  return files.map((file) => ({ ...file }))
}

function workingFileFromMetadata(file: DraftFileMetadata): DraftWorkingFile {
  return { ...file, dirty: false }
}

function workingFileWithText(file: DraftWorkingFile | DraftFileMetadata, text: string): DraftWorkingFile {
  const content = encodeBase64Text(text)
  return {
    ...file,
    content,
    size: new TextEncoder().encode(text).byteLength,
    previewState: 'text',
    dirty: true,
  }
}

function workingFileFromLoaded(file: DraftFile, metadata?: DraftFileMetadata, dirty = false): DraftWorkingFile {
  const preview = inspectDraftFile(file)
  return {
    path: file.path,
    size: metadata?.size ?? preview?.size ?? 0,
    digest: metadata?.digest ?? `sha256:${'0'.repeat(64)}`,
    ...(file.executable === undefined ? {} : { executable: file.executable }),
    content: file.content,
    previewState: preview?.state,
    dirty,
  }
}

/**
 * The idempotency identity is the canonical submitted file payload. Sorting
 * by path makes retries stable even when a caller rebuilt the same manifest
 * in a different order; the shape mirrors the server's delta canonicalizer.
 */
export function canonicalDraftFiles(files: DraftFileUpdate[]): string {
  return JSON.stringify([...files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0).map((file) => {
    if ('digest' in file) {
      return {
        path: file.path,
        ...(file.sourcePath === undefined ? {} : { sourcePath: file.sourcePath }),
        digest: file.digest,
      }
    }
    return {
      path: file.path,
      content: file.content,
      ...(file.executable === true ? { executable: true } : {}),
    }
  }))
}

export async function draftPayloadFingerprint(
  files: DraftFileUpdate[],
  binding?: { expectedRevision?: number; expectedDigest?: string },
): Promise<string> {
  const canonicalFiles = JSON.parse(canonicalDraftFiles(files)) as unknown
  const canonical = JSON.stringify({
    ...(binding?.expectedRevision === undefined ? {} : { expectedRevision: binding.expectedRevision }),
    ...(binding?.expectedDigest === undefined ? {} : { expectedDigest: binding.expectedDigest }),
    files: canonicalFiles,
  })
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
    return `sha256:${Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
  }
  // Browsers without Web Crypto still get a deterministic binding. This path
  // is only an idempotency key discriminator; the server validates the body.
  return `canonical:${canonical}`
}

/**
 * Build the sparse PUT manifest for the saved draft revision. The server
 * resolves references against that exact revision, so only bytes that changed
 * (or are new) travel over the wire. A local rename can retain a large or
 * binary file by pointing at its previous saved path; the server validates the
 * digest before moving the bytes. Missing paths are intentionally omitted and
 * are therefore deleted by the revision writer.
 */
export async function buildDraftDeltaFiles(
  savedFiles: DraftFileMetadata[],
  workingFiles: DraftWorkingFile[],
  renameOrigins: Record<string, string> = {},
): Promise<DraftFileUpdate[]> {
  const savedByPath = new Map(savedFiles.map((file) => [file.path, file]))
  const delta: DraftFileUpdate[] = []

  for (const file of workingFiles) {
    const mappedSource = renameOrigins[file.path]
    const sourcePath = mappedSource && mappedSource !== file.path && savedByPath.has(mappedSource)
      ? mappedSource
      : savedByPath.has(file.path)
        ? file.path
        : undefined
    const saved = sourcePath === undefined ? undefined : savedByPath.get(sourcePath)
    const sameSavedMetadata = saved !== undefined && saved.digest === file.digest && saved.size === file.size && saved.executable === file.executable

    if (!sameSavedMetadata || file.dirty === true) {
      if (file.content === undefined) throw new Error(`Load ${file.path} before saving its changes.`)
      delta.push({ path: file.path, content: file.content, ...(file.executable === true ? { executable: true } : {}) })
      continue
    }

    const reference: DraftFileReference = { path: file.path, digest: file.digest }
    if (sourcePath !== undefined && sourcePath !== file.path) reference.sourcePath = sourcePath
    delta.push(reference)
  }

  return delta
}

/** Carry a rename chain back to the saved path that still owns its bytes. */
export function renameOriginForPath(
  selectedPath: string,
  renameOrigins: Readonly<Record<string, string>>,
  savedFiles: DraftFileMetadata[],
  releaseBaseEntries: ReadonlyArray<Pick<ReleaseBaselineEntry, 'path'>>,
): string | undefined {
  const carriedOrigin = renameOrigins[selectedPath]
  if (carriedOrigin && carriedOrigin !== selectedPath) return carriedOrigin
  if (savedFiles.some((file) => file.path === selectedPath)) return selectedPath
  return releaseBaseEntries.some((entry) => entry.path === selectedPath) ? selectedPath : undefined
}

function filesEqual(left: DraftFileMetadata[], right: DraftWorkingFile[]): boolean {
  if (left.length !== right.length) return false
  const rightByPath = new Map(right.map((file) => [file.path, file]))
  return left.every((file) => {
    const other = rightByPath.get(file.path)
    return other?.digest === file.digest && other.size === file.size && other.executable === file.executable && other.dirty !== true
  })
}

function firstPath(files: DraftFileLike[]): string | null {
  return files.find((file) => editableText(file) !== null)?.path ?? files[0]?.path ?? null
}

function draftStorageKey(resourceId: string, baseDigest: string): string {
  return `${DRAFT_STORAGE_PREFIX}${encodeURIComponent(resourceId)}:${encodeURIComponent(baseDigest)}`
}

function readPersistence(key: string): DraftPersistence | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const value = JSON.parse(raw) as { draftId?: unknown; createKey?: unknown }
    if (typeof value.createKey !== 'string' || value.createKey.length < 8 || value.createKey.length > 256) return null
    return { createKey: value.createKey, ...(typeof value.draftId === 'string' && value.draftId.length > 0 ? { draftId: value.draftId } : {}) }
  } catch {
    return null
  }
}

function writePersistence(key: string, value: DraftPersistence): void {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(key, JSON.stringify(value)) } catch { /* Private browsing may deny storage; memory state remains usable. */ }
}

function clearPersistence(key: string): void {
  if (typeof window === 'undefined') return
  try { window.localStorage.removeItem(key) } catch { /* Ignore storage cleanup failures. */ }
}

function validDraftPath(path: string): string | null {
  const normalized = path.normalize('NFC')
  if (!normalized || normalized !== path || normalized.length > 4_096 || normalized.startsWith('/') || normalized.endsWith('/') || normalized.includes('\\') || normalized.includes(':') || normalized.includes('//') || /[<>:"|?*\u0000-\u001f\u007f]/u.test(normalized)) return 'Use a safe relative file path.'
  for (const segment of normalized.split('/')) {
    if (!segment || segment === '.' || segment === '..' || segment.endsWith('.') || segment.endsWith(' ')) return 'Use a safe relative file path.'
  }
  return null
}

export function operationKey(ref: MutableRefObject<DraftOperation | null>, prefix: string, draft: DraftView, payloadFingerprint: string, version?: string): string {
  const sameOperation = ref.current?.draftId === draft.id && ref.current.revision === draft.revision && ref.current.version === version && ref.current.payloadFingerprint === payloadFingerprint
  if (!sameOperation || !ref.current) ref.current = { draftId: draft.id, revision: draft.revision, ...(version === undefined ? {} : { version }), payloadFingerprint, key: idempotencyKey(prefix) }
  return ref.current.key
}

function isAbortError(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && (value as { name?: unknown }).name === 'AbortError')
}

export async function loadImmutableReleaseBaseline(resourceId: string, expectedDigest: `sha256:${string}`, signal: AbortSignal): Promise<ImmutableReleaseBaseline> {
  const manifest = await api.releaseFiles(resourceId, signal)
  if (manifest.release.digest !== expectedDigest) throw new Error('The release file manifest changed while opening the draft.')
  const entries = (manifest.files ?? []).map((entry): ReleaseBaselineEntry => ({
    path: entry.path,
    size: entry.size,
    previewState: entry.previewState,
    contentDigest: entry.contentDigest,
    ...(entry.executable === undefined ? {} : { executable: entry.executable }),
  }))
  return { entries, files: [] }
}

function baselineEntriesFromMetadata(files: DraftFileMetadata[]): ReleaseBaselineEntry[] {
  return files.map((file) => ({
    path: file.path,
    size: file.size,
    previewState: inspectDraftFile(workingFileFromMetadata(file))?.state ?? 'binary',
    contentDigest: file.digest,
    ...(file.executable === undefined ? {} : { executable: file.executable }),
  }))
}

export function releaseBaselineStatus(entry: ReleaseBaselineEntry | undefined, baseFile: DraftFile | undefined, currentFile: { path: string; content?: string; size?: number; digest?: `sha256:${string}`; executable?: boolean; dirty?: boolean } | undefined, currentDigest?: `sha256:${string}` | null, currentSize?: number | null): DraftSurfaceEntry['status'] {
  if (!currentFile) return 'removed'
  if (!entry) return 'added'
  if (currentFile.dirty === true) return 'changed'
  if (baseFile && currentFile.content !== undefined) return baseFile.content !== currentFile.content || baseFile.executable !== currentFile.executable ? 'changed' : 'unchanged'
  if (entry.executable !== currentFile.executable) return 'changed'
  const digest = currentDigest === undefined ? currentFile.digest : currentDigest
  const size = currentSize === undefined ? currentFile.size : currentSize
  if (digest === undefined) return 'checking'
  if (digest === null || !entry.contentDigest) return 'unknown'
  if (digest !== entry.contentDigest) return 'changed'
  if (entry.size !== undefined && size !== null && size !== undefined && entry.size !== size) return 'changed'
  return 'unchanged'
}

interface ErrorBoundaryProps { fallback: ReactNode; children: ReactNode }
interface ErrorBoundaryState { failed: boolean }

class DraftRendererBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false }
  static getDerivedStateFromError(): ErrorBoundaryState { return { failed: true } }
  render() { return this.state.failed ? this.props.fallback : this.props.children }
}

export function DraftEditor({ resourceId, baseDigest, baseVersion, initialDraft, resumeDraftId, closeRequest = 0, onClose, onDraftChange, onDirtyChange }: DraftEditorProps) {
  const [draft, setDraft] = useState<DraftView | null>(null)
  const [releaseBaseFiles, setReleaseBaseFiles] = useState<DraftFile[]>([])
  const [releaseBaseEntries, setReleaseBaseEntries] = useState<ReleaseBaselineEntry[]>([])
  const [savedFiles, setSavedFiles] = useState<DraftFileMetadata[]>([])
  const [workingFiles, setWorkingFiles] = useState<DraftWorkingFile[]>([])
  const [renameOrigins, setRenameOrigins] = useState<Record<string, string>>({})
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [mode, setMode] = useState<'edit' | 'diff'>('diff')
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>('files')
  const [creating, setCreating] = useState(false)
  const [resuming, setResuming] = useState(true)
  const [reloading, setReloading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [version, setVersion] = useState(baseVersion)
  const [newPath, setNewPath] = useState('')
  const [addingFile, setAddingFile] = useState(false)
  const [surfaceRevision, setSurfaceRevision] = useState(0)
  const [message, setMessage] = useState<{ kind: 'success' | 'error' | 'warning'; text: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [baseLoadingPath, setBaseLoadingPath] = useState<string | null>(null)
  const [baseLoadError, setBaseLoadError] = useState<{ path: string; text: string } | null>(null)
  const [currentLoadingPath, setCurrentLoadingPath] = useState<string | null>(null)
  const [currentLoadError, setCurrentLoadError] = useState<{ path: string; text: string } | null>(null)
  const requestGeneration = useRef(0)
  const persistence = useRef<DraftPersistence | null>(null)
  const saveOperation = useRef<DraftOperation | null>(null)
  const publishOperation = useRef<DraftOperation | null>(null)
  const releaseBaseRef = useRef<DraftFile[]>([])
  const releaseBaseEntriesRef = useRef<ReleaseBaselineEntry[]>([])
  const releaseBaselineLoadedRef = useRef(false)
  const baseLoadGeneration = useRef(0)
  const currentLoadGeneration = useRef(0)
  const surfaceRef = useRef<DraftSurfaceHandle | null>(null)
  const workspaceTabRefs = useRef<Partial<Record<WorkspaceTab, HTMLButtonElement>>>({})
  const builderAdapter = useMemo(() => createSkillBuilderAdapter(), [])

  const selectedFile = useMemo(() => workingFiles.find((file) => file.path === selectedPath) ?? null, [selectedPath, workingFiles])
  const selectedBasePath = selectedPath ? renameOrigins[selectedPath] ?? selectedPath : null
  const selectedBaseEntry = useMemo(() => {
    return selectedBasePath ? releaseBaseEntries.find((entry) => entry.path === selectedBasePath) ?? null : null
  }, [releaseBaseEntries, selectedBasePath])
  const selectedBaseFile = useMemo(() => {
    return selectedBasePath ? releaseBaseFiles.find((file) => file.path === selectedBasePath) ?? null : null
  }, [releaseBaseFiles, selectedBasePath])
  const selectedPreview = inspectDraftFile(selectedFile)
  const selectedText = selectedPreview?.text ?? null
  const selectedIsEditable = selectedPreview?.state === 'text' && typeof selectedFile?.content === 'string'
  const selectedFilePresent = selectedFile !== null
  const selectedCurrentError = selectedPath && currentLoadError?.path === selectedPath ? currentLoadError.text : null
  const selectedBaseError = selectedBasePath && baseLoadError?.path === selectedBasePath ? baseLoadError.text : null
  const uploadDraft = draft?.origin === 'upload' || resourceId.startsWith('upload:')
  const canLoadSelectedBase = !selectedFilePresent || selectedPreview?.state === 'text'
  const selectedBaseLoading = !uploadDraft && canLoadSelectedBase && selectedBaseEntry?.previewState === 'text' && !selectedBaseFile && !selectedBaseError && (baseLoadingPath === selectedBasePath || baseLoadingPath === null)
  const selectedCurrentLoading = selectedPath !== null && currentLoadingPath === selectedPath
  const entries = useMemo<DraftSurfaceEntry[]>(() => {
    const paths = new Set([...releaseBaseEntries.map((entry) => entry.path), ...workingFiles.map((file) => file.path)])
    return [...paths].sort().map((path) => {
      const entry = releaseBaseEntries.find((candidate) => candidate.path === path)
      const base = releaseBaseFiles.find((file) => file.path === path)
      const current = workingFiles.find((file) => file.path === path)
      return { path, status: releaseBaselineStatus(entry, base, current, current?.digest, current?.size) }
    })
  }, [releaseBaseEntries, releaseBaseFiles, workingFiles])
  const hasFileChanges = draft !== null && !filesEqual(savedFiles, workingFiles)
  const liveText = useMemo(() => surfaceRef.current?.readCurrent(), [selectedPath, selectedText, surfaceRevision])
  const hasLiveEdit = mode === 'edit' && selectedIsEditable && liveText !== null && liveText !== selectedText
  const hasChanges = hasFileChanges || hasLiveEdit
  const busy = creating || resuming || reloading || saving || publishing
  const storageKey = draftStorageKey(resourceId, baseDigest)
  const hasChangesRef = useRef(false)
  hasChangesRef.current = hasChanges

  const shouldBlockNavigation = useCallback(() => {
    return hasChangesRef.current && !window.confirm('Discard unsaved changes and leave the editor? Saved draft revisions are not affected.')
  }, [])
  useBlocker({ shouldBlockFn: shouldBlockNavigation, enableBeforeUnload: () => hasChangesRef.current })

  function matchesDraftSource(next: DraftView): boolean {
    if (resumeDraftId && next.id !== resumeDraftId) return false
    if (initialDraft) return next.id === initialDraft.id
    if (resourceId.startsWith('upload:')) return true
    return next.baseResourceId === resourceId && next.baseDigest === baseDigest
  }

  function installServerDraft(next: DraftView): void {
    const metadata = next.files.map((file) => ({ ...file }))
    const previousByPath = new Map(workingFiles.map((file) => [file.path, file]))
    const files = metadata.map((file): DraftWorkingFile => {
      const previous = previousByPath.get(file.path)
      return previous?.content !== undefined && previous.dirty !== true && previous.digest === file.digest && previous.size === file.size && previous.executable === file.executable
        ? { ...file, content: previous.content, ...(previous.previewState === undefined ? {} : { previewState: previous.previewState }), dirty: false }
        : workingFileFromMetadata(file)
    })
    const uploadOrigin = next.origin === 'upload' || resourceId.startsWith('upload:')
    if (!releaseBaselineLoadedRef.current && (uploadOrigin || next.revision === 0)) {
      releaseBaseRef.current = []
      setReleaseBaseFiles([])
      const entries = baselineEntriesFromMetadata(metadata)
      releaseBaseEntriesRef.current = entries
      setReleaseBaseEntries(entries)
      releaseBaselineLoadedRef.current = true
    }
    setDraft({ ...next, files: metadata })
    setSavedFiles(metadata)
    setWorkingFiles(files)
    setRenameOrigins({})
    setSelectedPath((current) => current && files.some((file) => file.path === current) ? current : firstPath(files))
    setMode('diff')
    setWorkspaceTab('files')
    currentLoadGeneration.current += 1
    setCurrentLoadingPath(null)
    setCurrentLoadError(null)
    setVersion((current) => current || baseVersion)
    saveOperation.current = null
    publishOperation.current = null
    setSurfaceRevision((current) => current + 1)
  }

  useEffect(() => {
    if (draft) onDraftChange?.(draft)
  }, [draft?.digest, draft?.id, draft?.revision, onDraftChange])

  useEffect(() => {
    onDirtyChange?.(hasChanges)
  }, [hasChanges, onDirtyChange])

  useEffect(() => () => { onDirtyChange?.(false) }, [onDirtyChange])

  function syncSurfaceFiles(): DraftWorkingFile[] {
    if (!selectedFile || !selectedIsEditable) return workingFiles
    const currentText = surfaceRef.current?.readCurrent()
    if (currentText === undefined || currentText === null || currentText === selectedText) return workingFiles
    return workingFiles.map((file) => file.path === selectedFile.path ? workingFileWithText(file, currentText) : file)
  }

  function getPersistence(): DraftPersistence {
    if (persistence.current) return persistence.current
    const stored = readPersistence(storageKey)
    const next = stored ?? { createKey: idempotencyKey('draft-create') }
    persistence.current = next
    return next
  }

  function requestClose(): void {
    if (creating || resuming || reloading || saving || publishing) {
      setMessage({ kind: 'warning', text: 'Wait for the current registry request to finish before closing.' })
      return
    }
    if (hasChanges && !window.confirm('Discard unsaved changes and close the editor? Saved draft revisions are not affected.')) return
    onClose()
  }

  useEffect(() => {
    const generation = ++requestGeneration.current
    const controller = new AbortController()
    setDraft(null)
    releaseBaseRef.current = []
    releaseBaseEntriesRef.current = []
    releaseBaselineLoadedRef.current = false
    setReleaseBaseFiles([])
    setReleaseBaseEntries([])
    setSavedFiles([])
    setWorkingFiles([])
    setRenameOrigins({})
    setSelectedPath(null)
    setMode('diff')
    setWorkspaceTab('files')
    setVersion(baseVersion)
    setCreating(false)
    setReloading(false)
    setSaving(false)
    setPublishing(false)
    setMessage(null)
    setError(null)
    setBaseLoadingPath(null)
    setBaseLoadError(null)
    setCurrentLoadingPath(null)
    setCurrentLoadError(null)
    currentLoadGeneration.current += 1
    setResuming(true)
    persistence.current = readPersistence(storageKey)
    saveOperation.current = null
    publishOperation.current = null
    if (initialDraft) {
      const nextPersistence = { createKey: persistence.current?.createKey ?? idempotencyKey('upload-draft'), draftId: initialDraft.id }
      persistence.current = nextPersistence
      writePersistence(storageKey, nextPersistence)
      installServerDraft(initialDraft)
      setResuming(false)
      return () => { controller.abort(); requestGeneration.current += 1 }
    }

    const savedDraftId = resumeDraftId ?? persistence.current?.draftId
    const shouldLoadReleaseBase = !resourceId.startsWith('upload:')
    const basePromise = shouldLoadReleaseBase
      ? loadImmutableReleaseBaseline(resourceId, baseDigest, controller.signal)
      : Promise.resolve<ImmutableReleaseBaseline | null>(null)
    const draftPromise = savedDraftId
      ? api.draft(savedDraftId, controller.signal)
      : Promise.resolve(null)
    void Promise.allSettled([basePromise, draftPromise]).then(([baseResult, draftResult]) => {
      if (generation !== requestGeneration.current || controller.signal.aborted) return
      if (baseResult.status === 'fulfilled' && baseResult.value) {
        releaseBaseRef.current = cloneFiles(baseResult.value.files)
        setReleaseBaseFiles(cloneFiles(baseResult.value.files))
        releaseBaseEntriesRef.current = baseResult.value.entries.map((entry) => ({ ...entry }))
        setReleaseBaseEntries(baseResult.value.entries.map((entry) => ({ ...entry })))
        releaseBaselineLoadedRef.current = true
      } else if (baseResult.status === 'rejected' && !isAbortError(baseResult.reason)) {
        setError(baseResult.reason instanceof ApiError ? baseResult.reason.message : baseResult.reason instanceof Error ? baseResult.reason.message : 'Could not load the immutable release files.')
      }
      if (draftResult.status === 'fulfilled' && draftResult.value) {
        const response = draftResult.value
        if (!matchesDraftSource(response.draft)) {
          clearPersistence(storageKey)
          persistence.current = null
          setMessage({ kind: 'warning', text: 'The saved draft belongs to another release. Start a new draft here.' })
        } else {
          installServerDraft(response.draft)
          setMessage({ kind: 'success', text: `Resumed draft at revision ${response.draft.revision}.` })
        }
      } else if (draftResult.status === 'rejected' && !isAbortError(draftResult.reason)) {
        const cause = draftResult.reason
        if (cause instanceof ApiError && cause.status === 404) {
          clearPersistence(storageKey)
          persistence.current = null
          setMessage({ kind: 'warning', text: 'The saved draft is no longer available. Start a new draft here.' })
        } else {
          setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not resume the saved draft.')
        }
      }
      setResuming(false)
    })
    return () => { controller.abort(); requestGeneration.current += 1 }
  }, [baseDigest, baseVersion, initialDraft, resourceId, resumeDraftId, storageKey])

  useEffect(() => {
    const current = selectedPath ? workingFiles.find((file) => file.path === selectedPath) ?? null : null
    if (!draft || !current || current.content !== undefined || current.previewState !== undefined) {
      if (currentLoadingPath !== null) setCurrentLoadingPath(null)
      return
    }

    const generation = ++currentLoadGeneration.current
    const controller = new AbortController()
    const key = draftFileCacheKey(draft.id, draft.revision, draft.digest, current.path)
    setCurrentLoadingPath(current.path)
    setCurrentLoadError(null)
    const cached = draftFileCache.get(key)
    const request = cached
      ? Promise.resolve({ ...cached })
      : api.draftFile(draft.id, current.path, { revision: draft.revision, digest: draft.digest }, controller.signal)
        .then((response) => workingFileFromResponse(response.file))
        .then((loaded) => {
          cacheDraftFile(key, loaded)
          return loaded
        })
    void request.then((loaded) => {
      if (generation !== currentLoadGeneration.current || controller.signal.aborted) return
      if (loaded.path !== current.path || loaded.digest !== current.digest || loaded.size !== current.size || loaded.executable !== current.executable) {
        throw new Error('The draft changed while loading the selected file. Reload the draft before continuing.')
      }
      setWorkingFiles((files) => files.map((file) => file.path === current.path && file.digest === current.digest ? { ...file, ...loaded, dirty: false } : file))
      if ((draft.origin === 'upload' || resourceId.startsWith('upload:')) && !releaseBaseRef.current.some((file) => file.path === current.path) && loaded.content !== undefined) {
        const baseline: DraftFile = { path: loaded.path, content: loaded.content, ...(loaded.executable === undefined ? {} : { executable: loaded.executable }) }
        releaseBaseRef.current = [...releaseBaseRef.current, baseline]
        setReleaseBaseFiles((files) => files.some((file) => file.path === baseline.path) ? files : [...files, baseline])
      }
    }).catch((cause: unknown) => {
      if (generation !== currentLoadGeneration.current || controller.signal.aborted || isAbortError(cause)) return
      setCurrentLoadError({ path: current.path, text: cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not load the selected draft file.' })
    }).finally(() => {
      if (generation === currentLoadGeneration.current) setCurrentLoadingPath(null)
    })
    return () => {
      controller.abort()
      if (generation === currentLoadGeneration.current) currentLoadGeneration.current += 1
    }
  }, [draft, resourceId, selectedPath, workingFiles])

  useEffect(() => {
    const path = selectedBasePath
    const metadata = selectedBaseEntry
    if (uploadDraft || !path || !metadata || metadata.previewState !== 'text' || (selectedFilePresent && selectedPreview?.state !== 'text') || releaseBaseFiles.some((file) => file.path === path)) {
      if (baseLoadingPath !== null) setBaseLoadingPath(null)
      return
    }

    const generation = ++baseLoadGeneration.current
    const controller = new AbortController()
    setBaseLoadingPath(path)
    setBaseLoadError(null)
    void api.releaseFile(resourceId, path, controller.signal).then((response) => {
      if (generation !== baseLoadGeneration.current || controller.signal.aborted) return
      if (response.release.digest !== baseDigest) throw new Error('The release file changed while opening the draft.')
      const entry = response.files.find((candidate) => candidate.path === path)
      if (!entry || entry.previewState !== 'text' || typeof entry.contents !== 'string') throw new Error('The selected release file is not available for preview.')
      const loaded: DraftFile = { path, content: encodeBase64Text(entry.contents), ...(entry.executable === undefined ? (metadata.executable === undefined ? {} : { executable: metadata.executable }) : { executable: entry.executable }) }
      releaseBaseRef.current = [...releaseBaseRef.current.filter((file) => file.path !== path), loaded]
      setReleaseBaseFiles((current) => current.some((file) => file.path === path) ? current : [...current, loaded])
    }).catch((cause: unknown) => {
      if (generation !== baseLoadGeneration.current || controller.signal.aborted || isAbortError(cause)) return
      setBaseLoadError({ path, text: cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not load the selected release file.' })
    }).finally(() => {
      if (generation === baseLoadGeneration.current) setBaseLoadingPath(null)
    })
    return () => {
      controller.abort()
      if (generation === baseLoadGeneration.current) baseLoadGeneration.current += 1
    }
  }, [baseDigest, releaseBaseFiles, resourceId, selectedBaseEntry, selectedBasePath, selectedFilePresent, selectedPreview?.state, uploadDraft])

  useEffect(() => {
    if (closeRequest > 0) requestClose()
  }, [closeRequest])

  async function startDraft(): Promise<void> {
    const generation = ++requestGeneration.current
    const stored = getPersistence()
    writePersistence(storageKey, stored)
    setCreating(true)
    setError(null)
    setMessage(null)
    try {
      const response = await api.createDraft(resourceId, baseDigest, stored.createKey)
      if (generation !== requestGeneration.current) return
      const nextPersistence = { ...stored, draftId: response.draft.id }
      persistence.current = nextPersistence
      writePersistence(storageKey, nextPersistence)
      if (!matchesDraftSource(response.draft)) throw new Error('The registry returned a draft for a different release.')
      installServerDraft(response.draft)
      setMessage({ kind: 'success', text: response.idempotent ? 'Reopened your existing draft.' : 'Draft created from this release.' })
    } catch (cause) {
      if (generation !== requestGeneration.current) return
      setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not start a draft.')
    } finally {
      if (generation === requestGeneration.current) setCreating(false)
    }
  }

  async function reloadDraft(): Promise<void> {
    if (!draft || reloading || saving || publishing) return
    if (hasChanges && !window.confirm('Reload the saved revision and discard local changes?')) return
    const generation = ++requestGeneration.current
    setMode('diff')
    setReloading(true)
    setError(null)
    setMessage(null)
    try {
      const response = await api.draft(draft.id)
      if (generation !== requestGeneration.current) return
      if (!matchesDraftSource(response.draft)) throw new Error('The registry returned a draft for a different release.')
      installServerDraft(response.draft)
      setMessage({ kind: 'success', text: `Draft reloaded at revision ${response.draft.revision}.` })
    } catch (cause) {
      if (generation !== requestGeneration.current) return
      setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not reload the draft.')
    } finally {
      if (generation === requestGeneration.current) setReloading(false)
    }
  }

  function selectFile(path: string): void {
    if (busy || path === selectedPath) return
    const nextFiles = syncSurfaceFiles()
    setWorkingFiles(nextFiles)
    setMode('diff')
    setSelectedPath(path)
    setCurrentLoadingPath(null)
    setCurrentLoadError(null)
    setMessage(null)
    setError(null)
  }

  function switchWorkspaceTab(next: WorkspaceTab): void {
    if (busy || next === workspaceTab) return
    if (next !== 'files') setWorkingFiles(syncSurfaceFiles())
    setWorkspaceTab(next)
  }

  function handleWorkspaceTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, current: WorkspaceTab): void {
    const isNavigationKey = event.key === 'ArrowRight' || event.key === 'ArrowLeft' || event.key === 'Home' || event.key === 'End'
    if (!isNavigationKey) return
    event.preventDefault()
    if (busy) return
    const currentIndex = WORKSPACE_TABS.indexOf(current)
    let nextIndex = currentIndex
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % WORKSPACE_TABS.length
    if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + WORKSPACE_TABS.length) % WORKSPACE_TABS.length
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = WORKSPACE_TABS.length - 1
    if (nextIndex === currentIndex) return
    const next = WORKSPACE_TABS[nextIndex]
    switchWorkspaceTab(next)
    workspaceTabRefs.current[next]?.focus()
  }

  function switchMode(next: 'edit' | 'diff'): void {
    if (busy || next === mode) return
    if (next === 'edit' && !selectedIsEditable) {
      setMessage({ kind: 'warning', text: 'Only UTF-8 text files can be edited.' })
      return
    }
    if (next === 'diff') setWorkingFiles(syncSurfaceFiles())
    setMode(next)
  }

  function onPierreContentChange(contents: string): void {
    if (!selectedPath) return
    setWorkingFiles((current) => current.map((file) => file.path === selectedPath ? workingFileWithText(file, contents) : file))
    setSurfaceRevision((current) => current + 1)
  }

  function addFile(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (busy) return
    const path = newPath.normalize('NFC')
    const pathError = validDraftPath(path)
    if (pathError) { setMessage({ kind: 'error', text: pathError }); return }
    if (entries.some((entry) => entry.path === path)) { setMessage({ kind: 'error', text: 'A file with that path already exists in this draft.' }); return }
    const currentFiles = syncSurfaceFiles()
    setWorkingFiles([...currentFiles, {
      path,
      size: 0,
      digest: `sha256:${'0'.repeat(64)}`,
      content: encodeBase64Text(''),
      previewState: 'text',
      dirty: true,
    }])
    setSelectedPath(path)
    setMode('edit')
    setNewPath('')
    setAddingFile(false)
    setMessage({ kind: 'success', text: `${path} added to the draft. Save the revision to persist it.` })
  }

  function renameFile(): void {
    if (busy || !selectedFile || !selectedPath) return
    const path = window.prompt('New relative path', selectedPath)?.normalize('NFC')
    if (!path || path === selectedPath) return
    const pathError = validDraftPath(path)
    if (pathError) { setMessage({ kind: 'error', text: pathError }); return }
    if (entries.some((entry) => entry.path === path)) { setMessage({ kind: 'error', text: 'A file with that path already exists in this draft.' }); return }
    // A reference must point into the currently saved draft revision. Prefer
    // the selected saved path when it exists; the release path can be older
    // than a resumed draft that was already renamed in a previous revision.
    const origin = renameOriginForPath(selectedPath, renameOrigins, savedFiles, releaseBaseEntries)
    const nextFiles = syncSurfaceFiles().map((file) => file.path === selectedPath ? { ...file, path } : file)
    setWorkingFiles(nextFiles)
    setRenameOrigins((current) => {
      const next = { ...current }
      delete next[selectedPath]
      if (origin && origin !== path) next[path] = origin
      return next
    })
    setSelectedPath(path)
    setMode('diff')
    setMessage({ kind: 'success', text: `${selectedPath} renamed locally. Save the revision to persist it.` })
  }

  function removeFile(): void {
    if (busy || !selectedFile || !selectedPath) return
    if (!window.confirm(`Remove ${selectedPath} from this draft?`)) return
    const nextFiles = syncSurfaceFiles().filter((file) => file.path !== selectedPath)
    setWorkingFiles(nextFiles)
    setRenameOrigins((current) => { const next = { ...current }; delete next[selectedPath]; return next })
    setSelectedPath(firstPath(nextFiles) ?? releaseBaseEntries.find((entry) => entry.path !== selectedPath)?.path ?? null)
    setMode('diff')
    setMessage({ kind: 'success', text: `${selectedPath} removed locally. Save the revision to persist it.` })
  }

  function restoreFile(): void {
    if (busy || selectedFile || !selectedBaseFile || !selectedPath) return
    const restoreMetadata: DraftFileMetadata | undefined = selectedBaseEntry ? {
      path: selectedPath,
      size: selectedBaseEntry.size,
      digest: selectedBaseEntry.contentDigest ?? `sha256:${'0'.repeat(64)}`,
      ...(selectedBaseEntry.executable === undefined ? {} : { executable: selectedBaseEntry.executable }),
    } : undefined
    const restored = workingFileFromLoaded({ ...selectedBaseFile, path: selectedPath }, restoreMetadata, true)
    setWorkingFiles((current) => [...current, restored])
    setMessage({ kind: 'success', text: `${selectedPath} restored locally. Save the revision to persist it.` })
  }

  async function saveDraft(): Promise<void> {
    if (!draft || !hasChanges || saving || reloading || publishing) return
    const snapshot = syncSurfaceFiles()
    if (snapshot.length === 0) { setMessage({ kind: 'error', text: 'A draft must contain at least one file.' }); return }
    const generation = ++requestGeneration.current
    setMode('diff')
    setWorkingFiles(snapshot)
    setSaving(true)
    setError(null)
    setMessage(null)
    try {
      const files = await buildDraftDeltaFiles(savedFiles, snapshot, renameOrigins)
      if (generation !== requestGeneration.current) return
      const payloadFingerprint = await draftPayloadFingerprint(files, { expectedRevision: draft.revision, expectedDigest: draft.digest })
      const key = operationKey(saveOperation, 'draft-save', draft, payloadFingerprint)
      if (generation !== requestGeneration.current) return
      const response = await api.updateDraft(draft.id, {
        expectedRevision: draft.revision,
        expectedDigest: draft.digest,
        files,
        idempotencyKey: key,
      })
      if (generation !== requestGeneration.current) return
      installServerDraft(response.draft)
      saveOperation.current = null
      setMessage({ kind: 'success', text: `Saved revision ${response.draft.revision}.` })
    } catch (cause) {
      if (generation !== requestGeneration.current) return
      setMessage({ kind: cause instanceof ApiError && cause.status === 409 ? 'warning' : 'error', text: cause instanceof ApiError && cause.status === 409 ? 'This draft changed elsewhere. Reload it before saving again.' : cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not save the draft.' })
    } finally {
      if (generation === requestGeneration.current) setSaving(false)
    }
  }

  async function publishDraft(): Promise<void> {
    if (!draft || hasChanges || publishing || saving || reloading) return
    const nextVersion = version.trim()
    if (!nextVersion) { setMessage({ kind: 'error', text: 'Enter a release version before queuing a scan.' }); return }
    const generation = ++requestGeneration.current
    setPublishing(true)
    setError(null)
    setMessage(null)
    try {
      const payloadFingerprint = JSON.stringify({ expectedRevision: draft.revision, version: nextVersion })
      const key = operationKey(publishOperation, 'draft-publish', draft, payloadFingerprint, nextVersion)
      const response = await api.publishDraft(draft.id, { expectedRevision: draft.revision, version: nextVersion, idempotencyKey: key })
      if (generation !== requestGeneration.current) return
      publishOperation.current = null
      setMessage({ kind: 'success', text: `Release ${response.operation.version} queued for security scanning. It is not approved yet.` })
    } catch (cause) {
      if (generation !== requestGeneration.current) return
      setMessage({ kind: cause instanceof ApiError && cause.status === 409 ? 'warning' : 'error', text: cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not queue the release.' })
    } finally {
      if (generation === requestGeneration.current) setPublishing(false)
    }
  }

  const nativeFallback = <NativeDraftSurface entries={entries} selectedPath={selectedPath} baseFile={selectedBaseFile} currentFile={selectedFile} currentPreviewState={selectedPreview?.state ?? null} currentPreviewSize={selectedPreview?.size ?? null} basePreviewState={selectedBaseEntry?.previewState ?? null} basePreviewSize={selectedBaseEntry?.size ?? null} mode={mode} editable={selectedIsEditable} busy={busy} baseLoading={selectedBaseLoading} baseError={selectedBaseError} currentLoading={selectedCurrentLoading} currentError={selectedCurrentError} onSelect={selectFile} onContentChange={onPierreContentChange} />
  const workspaceIdentity = draft?.id ?? initialDraft?.id ?? resourceId
  const workspaceTabIds = {
    files: workspaceElementId(workspaceIdentity, 'tab-files'),
    build: workspaceElementId(workspaceIdentity, 'tab-build'),
    review: workspaceElementId(workspaceIdentity, 'tab-review'),
  }
  const workspacePanelIds = {
    files: workspaceElementId(workspaceIdentity, 'panel-files'),
    build: workspaceElementId(workspaceIdentity, 'panel-build'),
    review: workspaceElementId(workspaceIdentity, 'panel-review'),
  }

  return <section className="draft-editor">
    <header className="draft-editor-header">
      <div><span className="eyebrow">Draft workspace</span><h3>{draft ? draft.name : 'Start a draft from this release'}</h3><p className="helper">Editing creates a separate revision; the selected release stays unchanged.</p></div>
      <div className="row-actions"><Button kind="quiet" type="button" onClick={requestClose}>Close</Button>{draft && <Badge value={draft.status} />}</div>
    </header>
    {error && <ErrorState message={error} onRetry={draft ? () => void reloadDraft() : undefined} />}
    {message && <div className="draft-editor-message"><Notice kind={message.kind}>{message.text}</Notice></div>}
    {resuming && <LoadingState label="Looking for an open draft…" />}
    {!resuming && !draft && !initialDraft && <div className="draft-start"><p className="helper">The draft starts with the exact bytes and digest from version <strong>{baseVersion}</strong>. Nothing is saved until you start it.</p><Button kind="secondary" busy={creating} type="button" onClick={() => void startDraft()}>Start draft</Button></div>}
    {!resuming && !draft && initialDraft && <div className="draft-start"><p className="helper">This upload draft is no longer available in the registry.</p></div>}
    {!resuming && draft && <>
      <div className="draft-editor-meta"><span>Revision <strong>{draft.revision}</strong></span><span>Files <strong>{workingFiles.length}</strong></span><span>Size <strong>{formatBytes(draft.size)}</strong></span><span title={draft.digest}>Digest <code>{shortDigest(draft.digest)}</code></span>{hasChanges && <span className="draft-dirty">Local changes</span>}</div>
      <div className="draft-workspace-tabs" aria-label="Draft workspace" aria-orientation="horizontal" role="tablist">
        <button id={workspaceTabIds.files} aria-controls={workspacePanelIds.files} aria-disabled={busy} aria-selected={workspaceTab === 'files'} className={workspaceTab === 'files' ? 'draft-workspace-tab-active' : ''} ref={(node) => { workspaceTabRefs.current.files = node ?? undefined }} role="tab" tabIndex={workspaceTab === 'files' ? 0 : -1} type="button" onClick={() => switchWorkspaceTab('files')} onKeyDown={(event) => handleWorkspaceTabKeyDown(event, 'files')}>Files</button>
        <button id={workspaceTabIds.build} aria-controls={workspacePanelIds.build} aria-disabled={busy} aria-selected={workspaceTab === 'build'} className={workspaceTab === 'build' ? 'draft-workspace-tab-active' : ''} ref={(node) => { workspaceTabRefs.current.build = node ?? undefined }} role="tab" tabIndex={workspaceTab === 'build' ? 0 : -1} type="button" onClick={() => switchWorkspaceTab('build')} onKeyDown={(event) => handleWorkspaceTabKeyDown(event, 'build')}>Build with Eve</button>
        <button id={workspaceTabIds.review} aria-controls={workspacePanelIds.review} aria-disabled={busy} aria-selected={workspaceTab === 'review'} className={workspaceTab === 'review' ? 'draft-workspace-tab-active' : ''} ref={(node) => { workspaceTabRefs.current.review = node ?? undefined }} role="tab" tabIndex={workspaceTab === 'review' ? 0 : -1} type="button" onClick={() => switchWorkspaceTab('review')} onKeyDown={(event) => handleWorkspaceTabKeyDown(event, 'review')}>Review</button>
      </div>
      <div id={workspacePanelIds.files} aria-labelledby={workspaceTabIds.files} hidden={workspaceTab !== 'files'} role="tabpanel">
      {workspaceTab === 'files' && <>
        <div className="draft-file-actions"><Button kind="quiet" type="button" disabled={busy} onClick={() => setAddingFile((current) => !current)}>{addingFile ? 'Cancel add' : 'Add file'}</Button><Button kind="quiet" type="button" disabled={busy || !selectedFile} onClick={renameFile}>Rename</Button><Button kind="quiet" type="button" disabled={busy || !selectedFile} onClick={removeFile}>Remove</Button>{!selectedFile && selectedBaseFile && <Button kind="quiet" type="button" disabled={busy} onClick={restoreFile}>Restore selected file</Button>}</div>
        {addingFile && <form className="draft-add-file" onSubmit={addFile}><label><span>New relative path</span><input autoFocus value={newPath} onChange={(event) => setNewPath(event.target.value)} placeholder="docs/notes.md" /></label><Button kind="secondary" disabled={busy}>Add file</Button></form>}
        <div className="draft-editor-layout">
          <div className="draft-editor-main draft-editor-surface-main">
            <div className="draft-editor-toolbar"><div><strong>{selectedPath ?? 'No file selected'}</strong>{hasChanges && <span className="draft-dirty">Unsaved changes</span>}</div><div className="draft-view-switch" role="group" aria-label="Draft file view"><button type="button" className={mode === 'diff' ? 'draft-view-active' : ''} disabled={busy} onClick={() => switchMode('diff')}>Diff</button><button type="button" className={mode === 'edit' ? 'draft-view-active' : ''} disabled={busy || !selectedIsEditable} onClick={() => switchMode('edit')}>Edit</button></div></div>
            {selectedCurrentLoading ? <LoadingState label="Loading the selected draft file…" /> : selectedCurrentError ? <div className="release-file-placeholder"><Badge tone="muted" value="Draft file unavailable" /><p>{selectedCurrentError}</p></div> : <DraftRendererBoundary key={`${draft.id}:${draft.revision}:${draft.digest}:${selectedPath ?? 'none'}:${mode}`} fallback={nativeFallback}><Suspense fallback={<LoadingState label="Loading the file workspace…" />}><PierreDraftSurface ref={surfaceRef} draftId={draft.id} draftRevision={draft.revision} draftDigest={draft.digest} entries={entries} selectedPath={selectedPath} baseFile={selectedBaseFile} currentFile={selectedFile} currentPreviewState={selectedPreview?.state ?? null} currentPreviewSize={selectedPreview?.size ?? null} basePreviewState={selectedBaseEntry?.previewState ?? null} basePreviewSize={selectedBaseEntry?.size ?? null} maxPreviewBytes={MAX_TEXT_PREVIEW_BYTES} mode={mode} editable={selectedIsEditable} busy={busy} baseLoading={selectedBaseLoading} baseError={selectedBaseError} onSelect={selectFile} onEditChange={() => setSurfaceRevision((current) => current + 1)} onContentChange={onPierreContentChange} /></Suspense></DraftRendererBoundary>}
            <div className="draft-editor-actions"><Button kind="secondary" busy={saving} disabled={!hasChanges || busy && !saving} type="button" onClick={() => void saveDraft()}>Save revision</Button><label className="draft-version-field"><span>Next version</span><input aria-label="Next release version" disabled={busy} value={version} onChange={(event) => { publishOperation.current = null; setVersion(event.target.value) }} /></label><Button busy={publishing} disabled={hasChanges || busy && !publishing} type="button" onClick={() => void publishDraft()}>Queue release scan</Button></div>
          </div>
        </div>
      </>}
      </div>
      <div id={workspacePanelIds.build} aria-labelledby={workspaceTabIds.build} hidden={workspaceTab !== 'build'} role="tabpanel">
      {workspaceTab === 'build' && <SkillBuilderPanel draft={{ draftId: draft.id, revision: draft.revision, digest: draft.digest, ...(selectedPath ? { selectedPath } : {}) }} adapter={builderAdapter} canApply={!hasChanges && !busy} applyDisabledReason={hasChanges ? 'Save or discard local changes before applying an Eve proposal.' : busy ? 'Wait for the current draft operation to finish.' : undefined} onDraftRebound={(next) => {
        if (next.id !== draft.id || next.revision <= draft.revision) {
          setError('Eve returned an unexpected draft revision. Reload the draft before continuing.')
          return
        }
        installServerDraft(next)
      }} onApplied={(result) => {
        setMessage({ kind: 'success', text: `Eve applied the proposal and saved revision ${result.draft.revision}.` })
      }} />}
      </div>
      <div id={workspacePanelIds.review} aria-labelledby={workspaceTabIds.review} hidden={workspaceTab !== 'review'} role="tabpanel">
      {workspaceTab === 'review' && <DraftReviewPanel draft={draft} disabled={busy} />}
      </div>
      <footer className="draft-editor-footer"><span className="helper">Revision {draft.revision} is saved on the server. Reload before saving if someone else changed it.</span><Button kind="quiet" disabled={busy} type="button" onClick={() => void reloadDraft()}>Reload draft</Button></footer>
    </>}
  </section>
}

function NativeDraftSurface({ entries, selectedPath, baseFile, currentFile, currentPreviewState, currentPreviewSize, basePreviewState, basePreviewSize, mode, editable, busy, baseLoading, baseError, currentLoading, currentError, onSelect, onContentChange }: { entries: DraftSurfaceEntry[]; selectedPath: string | null; baseFile: DraftFile | null; currentFile: DraftWorkingFile | null; currentPreviewState: ReleaseFilePreviewState | null; currentPreviewSize: number | null; basePreviewState: ReleaseFilePreviewState | null; basePreviewSize: number | null; mode: 'edit' | 'diff'; editable: boolean; busy: boolean; baseLoading: boolean; baseError: string | null; currentLoading: boolean; currentError: string | null; onSelect: (path: string) => void; onContentChange: (contents: string) => void }) {
  const currentPreview = currentFile ? inspectDraftFile(currentFile) : null
  const basePreview = baseFile ? inspectDraftFile(baseFile) : null
  const text = currentPreview?.text ?? null
  const baseText = basePreview?.text ?? null
  const canShowDiff = (currentFile === null || currentPreviewState === 'text') && (baseFile ? basePreviewState === 'text' : basePreviewState === null)
  const baseUnavailable = baseFile === null && basePreviewState !== null && basePreviewState !== 'text'
  const placeholderState = baseUnavailable ? basePreviewState : currentPreviewState ?? basePreviewState
  const placeholderSize = currentPreviewSize ?? basePreviewSize
  return <div className="draft-surface draft-surface-native">
    <aside className="draft-surface-tree" aria-label="Draft files"><div className="release-tree-heading"><strong>Files</strong><span>{entries.length}</span></div><div className="release-file-list">{entries.map((entry) => <button className={`release-file-row ${entry.path === selectedPath ? 'release-file-row-selected' : ''}`.trim()} key={entry.path} type="button" disabled={busy} onClick={() => onSelect(entry.path)}><span aria-hidden="true">{entry.status === 'removed' ? '−' : entry.status === 'added' ? '+' : '▤'}</span><code title={entry.path}>{entry.path}</code><small>{entry.status}</small></button>)}</div></aside>
    <div className="draft-surface-code">{currentLoading ? <LoadingState label="Loading the selected draft file…" /> : currentError ? <div className="release-file-placeholder"><Badge tone="muted" value="Draft file unavailable" /><p>{currentError}</p></div> : baseLoading ? <LoadingState label="Loading the release baseline…" /> : baseError ? <div className="release-file-placeholder"><Badge tone="muted" value="Baseline unavailable" /><p>{baseError}</p></div> : mode === 'edit' && editable && text !== null ? <textarea aria-label={`Edit ${selectedPath ?? 'file'}`} className="draft-textarea" disabled={busy} spellCheck={false} value={text} onChange={(event) => onContentChange(event.target.value)} /> : mode === 'diff' && canShowDiff && (baseText !== null || text !== null) ? <div className="draft-native-diff"><div><span>Before</span><pre>{baseText ?? '(new file)'}</pre></div><div><span>After</span><pre>{text ?? '(removed file)'}</pre></div></div> : <div className="release-file-placeholder"><Badge tone="muted" value={previewLabel(placeholderState)} /><p>{previewReason(placeholderState)}</p>{placeholderSize !== null && <span className="helper">{formatBytes(placeholderSize)}</span>}</div>}</div>
  </div>
}
