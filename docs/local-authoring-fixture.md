# Repeatable local authoring verification

This opt-in fixture runs the real Nitro application, registry HTTP contracts,
file-backed state, and Files SDK filesystem storage. Separate deterministic
builder and upload-review services stand in for the model boundary. It does not
contact hosted Eve or AI Gateway and cannot establish hosted acceptance.
Required SkillsGuard scanning is a separate real Docker worker step.

The launcher archives the current committed Git source into a disposable build
folder. Uncommitted app changes are not included. It excludes checkout `.env`
files, links installed dependencies, generates local credentials and a temporary
builder TLS certificate, and starts children with explicit environments. It invokes the installed Vite entrypoint directly, without running a package
installer against the shared dependency links. The build uses production mode;
the disposable runtime uses development mode to permit the local HTTPS builder.
It does not rename or delete your environment files. Use Node 24, the pinned workspace
pnpm installation, OpenSSL, and tar. The current launcher is a macOS-oriented
local verification tool; the application's hosting and Rust CLI portability
contracts are separate.

The deterministic stubs use `scripts/local-m6-http.mjs` for registry callbacks.
Those requests have an 8-second default timeout and read at most 2 MiB of
response data, including streamed responses; invalid UTF-8 or JSON and oversized
responses fail with bounded, body-free errors. The helper's focused tests also
cover stalled and oversized responses.

## Start and seed

From the repository root:

```sh
node scripts/local-m6-fixture.mjs launch --reviewer-mode hold
```

Keep the launch process running. Its output reports the disposable run root and
local service URLs. Default ports are 5197 (registry), 5196 (builder HTTPS), and
5195 (reviewer HTTP); the launcher accepts explicit alternate ports. After the
app starts, use the reported run root:

```sh
node scripts/local-m6-fixture.mjs seed <run-root>
node scripts/local-m6-fixture.mjs status <run-root>
```

Seed configures SkillsGuard as required, leaves `allowUnscanned=false`, and
creates an inert two-text-file upload draft. Metadata contains the exact draft
route, revision, digest, and policy. The generated browser token is stored only
in the mode-0600 `work/local-browser-credentials.json`; use it only for the
reported loopback registry. Do not put credentials into evidence or screenshots.

For the editor tree, selection, syntax, and scroll check, opt into the bounded
large-tree profile:

```sh
node scripts/local-m6-fixture.mjs seed <run-root> --profile large-tree
```

This profile creates 128 files: `SKILL.md`, `README.md`, and 126 canonical
relative paths nested eight segments deep under `fixtures/large-tree`. The
paths are sent in ascending canonical order and remain well below the bundle
file, per-file, expanded-byte, and request limits. One nested `.ts` file has a
long line plus 64 short lines, and one nested `.json` file has a long property
value plus 64 rows. All files are ordinary text without executable flags,
plugin boundary paths, hooks, or package metadata; the fixture never imports or
executes their contents.

The mode-0600 `work/local-m6-fixture.json` contains a sanitized `manifest` for
this profile. It records each path's digest/size/line metadata, three distant
paths, the two long-line paths, and `browserProof.selectionPath`,
`browserProof.highlightPath`, and `browserProof.scrollPath`. It contains no
credentials or tokens. Use those exact paths when recording browser evidence;
the manifest is local correlation data and does not establish a browser pass by
itself. The default seed command remains the two-file profile and does not write
this large-tree manifest.

## Exercise the browser flow

1. Sign in and open the exact seeded draft route.
2. Open Build, send a bounded fixture prompt, inspect the proposal and diff, and
   verify that draft bytes have not changed before applying.
3. Apply explicitly, reload the route, and check the saved revision/digest.
4. Open Review and observe the held pending state. Use `status` to identify the
   reviewer session for the current draft revision.
5. Advance only that session, then use the browser's Refresh status control:

```sh
node scripts/local-m6-fixture.mjs advance <run-root> <reviewer-session-id>
```

The advance command performs the real reviewer prepare/complete callbacks; it
does not edit persistence directly. Test finding decisions and an explicit
rerun, checking that the new attempt remains pending until separately advanced.
Review output is advisory and never replaces required scan admission.

6. Explicitly queue a new release scan in the editor. Record its operation ID
   and exact artifact digest before running a worker. Do not repeat a queue
   request merely because a browser observation was delayed.

## Required scanner

`scripts/verify-local-authoring-scan.mjs` requires a mode-0600 local control file
containing the loopback origin, generated worker token and local precheck token,
expected job ID, expected artifact digest, and optional evidence path and
immutable SkillsGuard image ID. The default image ID is the recorded local
arm64 SkillsGuard image; another machine must have that exact image or explicitly
provide its separately verified immutable image ID. Mutable tags are rejected.

Create that control file from the generated fixture credentials and the exact
queued operation:

```sh
node scripts/local-m6-fixture.mjs prepare-scan <run-root> <expected-job-id> <expected-artifact-digest>
node --import tsx scripts/verify-local-authoring-scan.mjs --control /absolute/path/to/control.json
```

`prepare-scan` prints the control path and nonsecret correlation fields only.
It does not claim or execute a scan.

The verifier first reads the expected queued scan, then uses the real
WorkerRunner and DockerExecutor. It rejects mismatched jobs, digests, and policy
outcomes and writes sanitized scanner evidence. A denial is a test result;
never weaken policy to turn it into approval. After approval, verify the browser
catalog, release manifest, and edited file bytes against the same digest.

The script's separate negative regression uses only local HTTP and Docker
command stubs:

```sh
node --test scripts/local-m6-fixture.test.mjs scripts/local-m6-http.test.mjs scripts/verify-local-authoring-scan.test.mjs
```

## Stop

```sh
node scripts/local-m6-fixture.mjs stop <run-root>
```

`stop` writes an atomic mode-0600 request to the launcher's private
`work/stop-request.json`. The launch metadata records the stop protocol version
and path. The live launcher polls that request while the build or app is running,
then shuts down only its in-memory child handles; persisted process metadata is
never used to signal a PID. A request made during the build is consumed on the
next poll. The CLI returns after writing the request, so verify closure separately
by checking that the three owned service ports are no longer listening. Old launch
metadata without the current stop protocol is rejected clearly and does not signal
any persisted PID.

Keep any needed sanitized evidence separately from private credentials, logs,
certificates, and draft data. No command in this flow pushes Git or deploys to
Vercel.
