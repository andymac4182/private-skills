import { createHash } from 'node:crypto'

const edgeOrigin = (process.env.PSKILLS_EDGE_URL ?? 'http://127.0.0.1:8787').replace(/\/$/u, '')
const token = process.env.PSKILLS_EDGE_TOKEN
const requestedSkill = process.env.PSKILLS_EDGE_SKILL_NAME

if (!token) {
  throw new Error('PSKILLS_EDGE_TOKEN is required; pass a disposable registry token in the environment')
}

type JsonObject = Record<string, unknown>

async function jsonRequest(path: string, init: RequestInit = {}): Promise<{ response: Response; body: JsonObject }> {
  const response = await fetch(`${edgeOrigin}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  let body: unknown
  try {
    body = JSON.parse(text) as unknown
  } catch {
    body = { raw: text.slice(0, 500) }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error(`${path} returned a non-object response (${response.status})`)
  }
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${JSON.stringify(body)}`)
  }
  return { response, body: body as JsonObject }
}

const health = await fetch(`${edgeOrigin}/health`)
if (!health.ok) throw new Error(`/health returned ${health.status}`)

const me = await jsonRequest('/v1/me')
const capabilities = await jsonRequest('/v1/capabilities')
const skillsResponse = await jsonRequest('/v1/skills')
const skills = Array.isArray(skillsResponse.body.skills) ? skillsResponse.body.skills as JsonObject[] : []
const skill = skills.find(candidate =>
  candidate.state === 'approved' &&
  (requestedSkill === undefined || candidate.name === requestedSkill),
)
if (!skill) {
  throw new Error(requestedSkill
    ? `No approved skill named ${requestedSkill} was returned by the edge API`
    : 'No approved skill was returned by the edge API')
}

const resolutionResponse = await jsonRequest('/v1/resolve', {
  method: 'POST',
  body: JSON.stringify({ kind: 'skill', ref: skill.name, version: skill.version }),
})
const resolution = resolutionResponse.body.resolution as JsonObject | undefined
if (!resolution || typeof resolution.resourceId !== 'string' || typeof resolution.digest !== 'string') {
  throw new Error('The edge API returned an invalid resolution')
}

const authorizationResponse = await jsonRequest('/v1/install-authorizations', {
  method: 'POST',
  body: JSON.stringify(resolution),
})
const authorization = authorizationResponse.body.authorization as JsonObject | undefined
if (!authorization || typeof authorization.id !== 'string') {
  throw new Error('The edge API returned an invalid install authorization')
}

const grantResponse = await jsonRequest(
  `/v1/artifacts/${encodeURIComponent(resolution.digest)}/download`,
  {
    method: 'POST',
    body: JSON.stringify({ resourceId: resolution.resourceId, authorizationId: authorization.id }),
  },
)
const descriptor = grantResponse.body
if (typeof descriptor.url !== 'string' || typeof descriptor.digest !== 'string') {
  throw new Error('The edge API returned an invalid transfer descriptor')
}

const transfer = await fetch(descriptor.url, {
  headers: { authorization: `Bearer ${token}` },
})
const bytes = new Uint8Array(await transfer.arrayBuffer())
if (!transfer.ok) throw new Error(`transfer returned ${transfer.status}: ${new TextDecoder().decode(bytes).slice(0, 500)}`)
const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
if (digest !== descriptor.digest) {
  throw new Error(`transfer digest mismatch: expected ${descriptor.digest}, received ${digest}`)
}

console.log(JSON.stringify({
  health: health.status,
  me: me.response.status,
  capabilities: capabilities.response.status,
  skill: skill.name,
  resolve: resolutionResponse.response.status,
  authorization: authorizationResponse.response.status,
  grant: grantResponse.response.status,
  transfer: transfer.status,
  transferBytes: bytes.byteLength,
  digest,
}))
