# Private Skills interactive skill builder

This is the third Eve role in the Private Skills authoring flow. It is a
server-side assistant that reads bounded, server-selected draft files and
records pending patch proposals for a human editor to review.

The browser never receives either Eve's bearer token or the registry service
token. The registry BFF authenticates the user and draft namespace, allocates
an opaque `sessionKey`, and calls the internal route below. Eve's standard
`/eve/v1/*` routes are then reachable only through that server-side proxy.

## Internal seam

`POST /internal/builder/sessions` accepts a service-authenticated JSON body:

```json
{
  "sessionKey": "bff-generated-opaque-key",
  "draftId": "draft-id",
  "revision": 4,
  "digest": "sha256:...",
  "message": "Help me improve this skill"
}
```

It seeds durable Eve channel state and returns a bounded `202` receipt with
the Eve session id. `GET /internal/builder/status` returns configuration state
and reason codes without secrets. The user-facing BFF owns stream/follow-up
proxying, session-to-draft authorization, chat URL persistence, and apply or
reject operations.

The dynamic tools are `list_draft_files`, `read_draft_files`, and
`propose_file_changes`. The registry service computes `proposedDigest` from
the complete canonical bundle; the model cannot supply or override it. This
app has no apply, publish, install, scanner-policy, or execution tool.

## Configuration

The builder remains disabled unless all separate server-side configuration is
present and valid:

- `PSKILLS_BUILDER_EVE_API_TOKEN` protects Eve's standard routes.
- `PSKILLS_BUILDER_SERVICE_TOKEN` protects the internal session/status routes.
- `PSKILLS_BUILDER_REGISTRY_API_URL` and
  `PSKILLS_BUILDER_REGISTRY_TOKEN` reach the authoring BFF with the
  `skill-builder` tool identity and the dedicated `skills:builder` scope.
- `AI_GATEWAY_API_KEY` or a Vercel OIDC token authenticates the configured AI
  Gateway. `PSKILLS_AI_GATEWAY_BASE_URL` and
  `PSKILLS_AI_GATEWAY_TEAM_ID` are optional bounded configuration.
- `PSKILLS_BUILDER_MODEL` defaults to the reviewed `openai/gpt-5.5`
  identifier and is validated as `provider/model`.

Candidate file contents are treated as untrusted data and are never executed.
