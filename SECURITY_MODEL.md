# OptiEVE security model

Last reviewed against the local source: 2026-11-05.

This model covers the hosted web dashboard, MCP connector, EVE authorization,
read-only data services, development validation, source synchronization and public
packaging. It describes controls and review invariants, not a certification or
proof that every entry point has identical protections. Read
[SECURITY.md](SECURITY.md) for review guidance and operational requirements and
[AGENTS.md](AGENTS.md) for the development/private workflow. Check the current code
when relying on a claim; update this model when a boundary changes.

## Assets and security goals

| Asset | Required protection |
| --- | --- |
| EVE access/refresh tokens, PKCE state and token-encryption key | Prevent disclosure, ciphertext substitution, cross-user reuse and unauthorized connection replacement. |
| User/character associations, names, scopes, Client ID and runtime settings | Keep account metadata and personal API configuration out of development, public source and shared evidence. |
| Orders, assets, wallet data, mail, locations and industrial information | Read only for an authorized connected owner; limit collection, disclosure and retention to the requested feature. |
| EVE game state and permissions | Expose no game-changing operation and do not silently expand saved grants. |
| Results and user decisions | Keep source context, missing evidence, freshness, limits and conditional estimates truthful; untrusted text cannot grant authority. |
| Private runtime, database and hosting identity | Preserve them during code updates; do not mirror private data into development or distribute it. |
| Developer files, build inputs and source artifacts | Constrain sync, packaging and test cleanup to their intended inputs and outputs; preserve unrelated files. |
| Availability | Bound supported requests and workflows while acknowledging gateway/provider limits and remaining resource-exhaustion risks. |

## Actors and assumptions

An unauthenticated caller can attempt requests, malformed JSON, forged headers or
OAuth callbacks. An authenticated user can submit arbitrary tool arguments and
try another user's character or data selectors. A player or upstream response can
supply hostile text, malformed records, conflicting pages, unusual numbers or
misleading metadata. A local process can modify source, manifests or filesystem
paths while packaging or synchronization runs. Consider those inputs at each
boundary rather than trusting a prior successful check.

The trusted computing base includes the hosting audience/authentication gateway,
deployed worker code, EVE SSO and TLS endpoints, secret store, D1 access, browser
runtime, operator account, installed dependencies and build tools. The worker
trusts the gateway's `oai-authenticated-user-id` header; the application does not
cryptographically authenticate that header itself. The gateway must strip
caller-supplied identities and prevent direct access around its checks.

An operator with the key and database, or a compromised running worker, can access
authorization material. Encryption at rest does not contain that actor. Local
test/build tools run with the launching account's filesystem and process authority.
There is no blanket sandbox around those tools. Development and private folders
are an operating convention, not an OS access-control boundary between chats.

Read-only means no EVE game-state writes. Saving configuration, OAuth completion,
token refresh and disconnect change application authorization storage. Some ESI
read lookups use POST; HTTP method alone does not determine game-changing authority.

## Data flow and trust boundaries

1. **Gateway to application.** The hosting gateway enforces the private audience
   and supplies identity. The page uses gateway profile headers for display;
   private APIs use the stable user ID for ownership. Local mock sign-in provides
   development previews only and cannot establish production authentication.
2. **Connection and consent.** The signed-in user supplies an EVE Client ID and
   chooses supported read access. The server creates user-bound OAuth state and a
   PKCE challenge. EVE handles sign-in and consent; no EVE password or client
   secret is collected by this implementation.
3. **Callback to storage.** The server claims the matching unexpired state,
   exchanges the authorization code, validates the token and character, and
   persists identity-bound encrypted authorization with necessary metadata.
4. **Read selection to ESI.** Web or MCP arguments select an allowlisted dataset
   and owned connection. The server checks saved scopes, refreshes authorization
   if needed, resolves current corporation membership where required, and calls
   fixed EVE endpoints. Caller-supplied IDs do not establish ownership or roles.
5. **ESI to result.** Services validate and project data with feature-specific
   limits. Dashboard clients validate results again and keep them in memory for
   the selected view. Raw connector tools intentionally return more account data
   than summary dashboards; their results may remain in the calling chat.
6. **Development to private source.** Checked synthetic development code moves
   forward through the guarded sync. Private configuration and account state stay
   separate. Running-version verification is distinct from source parity.
7. **Development to distribution.** The public packager selects current source,
   rejects known private artifacts and verifies the resulting ZIP bytes. Review
   the actual outgoing archive and Git history before any authorized publication.

## Controls and review invariants

### Gateway, web API and MCP

Browser API POST routes require the trusted user header, exact configured Origin,
JSON input and bounded request bytes. The default limit is 4 KiB; the manufacturing
route allows 64 KiB. GET on that API is restricted to authenticated connection
status. Responses use private/no-store, identity/Cookie variation and nosniff
headers. These directives depend on the gateway and downstream clients honoring
them; they do not stop an authorized user from retaining a response.

MCP has its own JSON-RPC envelope, tool-schema and operation validation. Tool
execution requires the trusted user ID, including public-data tools. Discovery
metadata can be returned without application-level authentication. MCP does not
apply the browser API's Origin check; its deployment relies on the trusted gateway
and MCP transport. Its input limit is 32,000 bytes. Legacy batches allow at most
eight messages and a four MiB aggregate response, with later handlers withheld
when the remaining output budget is insufficient. Do not mistake that batch
budget for a universal upstream or single-tool response cap.

Request-body helpers bound retained bytes and discard overflow. Browser API
rejection paths drain unread bodies to preserve Windows local-worker connection
reuse. An upload that never finishes can delay its own response; the gateway must
also enforce connection and resource limits.

### Authorization lifecycle and encryption

OAuth uses PKCE S256, a hashed random state, user binding, a logical ten-minute
expiry and single-use state claiming. Token verification checks the signature
against EVE signing keys and validates issuer, audience, expiry and character
identity. Callback storage and disconnect checks prevent an earlier pending flow
from restoring a disconnected connection.

Token payloads and OAuth flow secrets use AES-256-GCM with a random 12-byte IV and
associated data bound to the relevant user/character or user/state. Plaintext
metadata is not made secret by encrypting the tokens. Keep the encryption key in
the runtime secret store and preserve its database pairing during updates.

Initial connect verifies that requested scopes were granted and stores returned
grants. Preserving reconnect has stricter equality checks: the encrypted flow
binds the selected character and saved supported-scope snapshot, and callback and
refresh validation reject mismatched grants. Ordinary reconnect is not a request
for broader access. Explicit scope-changing choices are separate operations.
The endpoint allowlists still constrain what the app can do with a token.

Refresh coordination and conditional database updates protect concurrent refresh,
rotation, disconnect and reconnect behavior. Failed or malformed refresh results
must not silently replace a valid saved authorization. Do not generalize these
checks into a promise of platform-wide transactionality or availability.

### Retained state and private results

The current database has three application tables:

| Table | Retained data |
| --- | --- |
| `eve_settings` | User association and Client ID. |
| `eve_oauth_states` | State hash, user association, encrypted flow and expiry. |
| `eve_connections` | User/character/corporation association, display name, scopes, encrypted token payload, expiry and refresh-lock metadata. |

The Client ID, identities, names, scope list and expiry/lock metadata are plaintext
configuration or metadata. There is no application table for orders, assets,
wallet history or manufacturing results. Expired OAuth state is unusable but
cleanup is opportunistic; logical expiry is not guaranteed immediate physical
erasure. Disconnect removes the selected connection and the user's pending
sign-ins, but does not remove the saved Client ID, revoke the provider grant,
erase earlier chat results or govern backup retention.

Dashboard selections and results are held in memory, with clearing on selection
changes, refresh and unmount. This is not a secure-memory erasure guarantee.
Browsers, extensions, calling chats, screenshots, operational logs and external
backups can retain data outside the application database. Use the private-use
chat for live reads, including tool outputs and verification captures.

### Read services, projections and evidence

Character/corporation catalogs define fixed endpoints, parameters, scopes and
pagination styles. Private reads check connection ownership and saved scopes
before using authorization. Corporation identity comes from the selected
character's current profile; ESI remains authoritative for membership and roles.
Documented asset-name and coordinate POSTs are read lookups, not game writes.
The planetary scope's provider name includes `manage_planets`; this implementation
exposes planetary reads only.

| Surface | Important projection and evidence boundary |
| --- | --- |
| Raw character/corporation MCP reads | Can include sensitive mail, location or other dataset fields. Allowlisting does not make returned player content trusted instructions or public data. |
| Overview and workspaces | Fetch selected datasets and distinguish missing grants, denied roles, malformed records and partial pages. Multi-read corporation results must not combine different corporations. |
| Reputation, extraction and freelance views | Use selected read grants and bounded fields. These views do not add contributor/participant lists, member tracking or observer histories. |
| Personal Industry and optional public labels | Colony list reads do not load layouts or contents. Optional displayed-row enrichment allows bounded public type/skill/system IDs, not private item/container/location/player IDs. This restriction is specific to those enrichments, not the separate explicit public-name tool. |
| Corporation asset detail workspace | Verifies the requested item in the selected asset page before custom name or coordinate lookup; does not save lookup results. |
| Skills, wallet, orders, inventory and jobs charts | Preserve reported semantics and numeric precision. Counts, quantities, cash flow, queue dates and job states are different evidence; none alone establishes profit, completion or usable stock. |
| Blueprint collection and reconciliation | Keep identity joins server-local, accepted pages transactional, unknown research/copy flags explicit, and independent source coverage/freshness visible. |
| Manufacturing | Bind character, owner, wallet/hangar selections, stock ancestry and exclusions. Use pinned recipe provenance and explicit costs; distinguish conditional modeled economics from realized profit or funded executable jobs. |

The overview/workspace and collection workflows generally share a 55-second
deadline and propagate cancellation into their component reads. Core EVE fetches
have a 20-second per-fetch timeout and do not follow redirects automatically.
Not every entry point has identical cancellation: the legacy MCP read calls
currently omit the incoming request signal, while manufacturing forwards it.
Do not claim a single global deadline or abort contract for every connector tool.

Blueprint reconciliation reads sequentially, with at most 50 pages and 50,000 raw
rows per feed, a 50,000-record union limit and one shared 55-second budget. Its
stream permits a 16 MiB final event, 4 KiB progress events, at most 256 progress
events and 17 MiB total. The blueprint-only stream allows 128 progress events.
Both use strict client validation and bounded table slices. Preserve
completion-time expiry checks, including known expiries alongside unknown page
metadata, and account for synchronous final aggregation in the deadline.

Asset-only blueprint classification uses pinned SDE category 9, including types
without manufacturing recipes. Assets cannot recover ME, TE or remaining runs.
Missing copy flags stay unknown; a reported non-copy flag does not prove an
original, researchability or unlimited runs. Matching checks selected blueprint
fields and physical quantities, not cross-source location equivalence.
Blueprint-only evidence is retained and conflicting matches are flagged.
All advertised pages, matching timestamps and a deduplicated union still do not
establish complete ownership or an atomic snapshot.

Manufacturing comparisons use a shared context; combined plans allocate stock,
copy runs, wallet funds and market depth without counting future output or sales
as current resources. Missing costs, incomplete depth, stale evidence and uncertain
catalog status keep results conditional. Public market data is not proof of
private-structure liquidity. The synthetic demo does not read connections or
account endpoints and is suitable for development verification.

### Local tooling, synchronization and public packaging

Development contains sanitized source and synthetic tests. Dependencies, builds,
caches and runtime state belong in external validation or the private runtime.
Test runners, compilers and package scripts execute with host-account authority;
do not run unreviewed code in an environment containing secrets or valuable data.
Cleanup must verify the exact owned scratch root and process, preserve uncertain
leftovers and avoid links or broad filename-based deletion.

Public-source checks reject private-runtime markers, known environment/data/key
artifacts, deployment bindings, personal machine paths, credential patterns,
unreviewed binaries, links and hard-linked source. These are heuristic and
structural checks, not recognition of every possible secret or personal fact.
The packager selects current working-tree bytes, including reviewed uncommitted
changes, and verifies archive entries against those bytes. It excludes Git
metadata and generated/runtime directories. Git attributes cannot silently drop
or rewrite the checked package selection. Review actual ZIP contents and Git
history separately; a checksum establishes identity, not authenticity or safety.

GitHub changes use dated `codex/` branches from current remote `main` and PRs,
with code and security review evidence tied to the current head commit. Public
promotion is a separate linked, sanitized PR after development acceptance.
When canonical local history differs from the published baseline, separate Git
staging carries only the reviewed source delta; canonical source, Git state and
approved sync manifests remain intact. This review convention is not itself
configured CI, branch protection or auto-merge, and a merge does not authorize
runtime deployment, broader EVE access or game writes. See the
[PR handoff workflow](PRIVATE_USE.md#github-pr-preparation).

Private sync is one-way and uses validated source, a private source manifest and
its approved development-side record. It rejects overlaps, unsafe links and
conflicting private source edits; a private manifest alone cannot authorize
deletion. It removes only unchanged previously managed source that development
deleted, preserves unmanaged private runtime files, and intentionally retains the
private hosting project ID. Locks, staging, rechecks and final verification do
not make the entire tree an atomic transaction: a filesystem failure can leave
a partial update. Stop and reconcile instead of force-copying or reconstructing
missing deletion authority. A successful check proves managed-source parity,
not dependency, database or running-version parity.

Catalog refresh stages public data outside development, verifies its recorded
hashes and schema with reviewed tooling, detects source races and older builds,
and uses the guarded sync after application. Precommit failures preserve the old
catalog; a later sync conflict remains a partial update requiring reconciliation.
The runtime checks catalog provenance/status but does not automatically replace
recipes. Trusted toolchain review remains necessary despite pinned hashes.

## Threat scenarios to consider in reviews

| Trigger | Boundary to verify |
| --- | --- |
| Spoofed gateway headers or direct worker access | Audience and identity enforcement must occur before the trusted application boundary. |
| Another user's character, wallet or item selector | Ownership, scope and current corporation checks must precede the read or detail lookup. |
| Replayed callback or disconnect during sign-in/refresh | One-time state, identity/scope binding and conditional persistence must preserve the selected authorization state. |
| Hostile mail, names or tool output | Text stays data; it cannot become markup, arbitrary fetch targets, commands or consent. |
| Changed pages, duplicate IDs or late-expiring evidence | Reject or label partial/conflicting evidence rather than manufacture a complete current total. |
| Oversized bodies, streams or endless uploads | Check the actual route's limits and remaining gateway/provider resource assumptions. |
| Old private source edits or forged sync manifests | Refuse unauthorized replacement/deletion and preserve runtime data and hosting identity. |
| Credentials or personal facts embedded in an allowed source file | Review content and outgoing artifacts in addition to structural scanners and ignore rules. |

## Residual risks and evidence limits

- A compromised gateway, worker, host account, dependency or key/database operator
  is outside the protection provided by application-level ownership and encryption.
- The current deployment is intended to remain private. These controls do not
  establish readiness for an anonymous public or broadly shared service.
- Record limits after parsing do not bound all upstream JSON bytes. Per-route
  deadlines and batch caps are not a global rate limiter or a universal memory,
  CPU, network or denial-of-service guarantee.
- Provider omissions, cache skew, pagination changes, role changes and catalog
  gaps remain possible. Cancellation cannot undo reads already completed.
- Logs, chat retention and backups are separate operational boundaries. Source
  checks do not remove a secret from earlier commits or previously shared files.
- Folder separation and instructions do not technically prevent another
  authorized local chat/process from reading private files.
- Synthetic tests establish the cases exercised. A build does not validate a
  hosted gateway, and a bounded live smoke does not prove every role, dataset,
  failure path, provider limit or the absence of vulnerabilities.

## Code map and review use

| Boundary | Implementation and verification |
| --- | --- |
| Gateway-facing identity and browser routes | [page identity](app/chatgpt-auth.ts), [web API](app/api/eve/%5B...path%5D/route.ts), [MCP](app/mcp/route.ts); [protocol tests](tests/mcp-security.mjs). |
| OAuth, encryption, ownership and read dispatch | [EVE service](app/lib/eve.ts), [character catalog](app/lib/character-data.ts), [corporation catalog](app/lib/corporation-data.ts), [callback](app/eve/callback/route.ts); [authorization tests](tests/eve-security.mjs). |
| Persistence and setup | [schema](db/schema.ts), [migrations](drizzle), [private-use guide](PRIVATE_USE.md); [connection client tests](tests/connection-client.mjs). |
| Request budgets and local runtime behavior | [body reader](app/lib/request-body.ts); [body tests](tests/request-body.mjs), [actual Wrangler tests](tests/wrangler-runtime.mjs). |
| Blueprint evidence and streams | [collection](app/lib/blueprint-collection.ts), [reconciliation](app/lib/blueprint-reconciliation.ts), [strict client](app/lib/blueprint-reconciliation-client.ts), [stream](app/lib/blueprint-reconciliation-stream.ts); [reader tests](tests/blueprint-reconciliation.mjs), [client tests](tests/blueprint-reconciliation-client.mjs), [stream tests](tests/blueprint-reconciliation-stream.mjs). |
| Manufacturing evidence | [assessment](app/lib/manufacturing-assessment.ts), [planning](app/lib/manufacturing-planning.ts), [stock](app/lib/manufacturing-stock.ts), [catalog](app/lib/manufacturing-catalog.ts); [assessment tests](tests/manufacturing-assessment.mjs), [planning tests](tests/manufacturing-planning.mjs). |
| Public selection and private sync | [source checks](scripts/public-source.mjs), [packager](scripts/package-public-source.mjs), [sync](scripts/sync-private-source.mjs); [public boundary tests](tests/public-source.mjs), [private boundary tests](tests/private-source.mjs). |
| Catalog tooling | [refresh workflow](scripts/refresh-manufacturing-catalog.mjs); [refresh tests](tests/catalog-refresh.mjs). |

Use the relevant entries and follow their callers rather than treating this map
as exhaustive. The [package scripts](package.json) list runnable suites. Keep
static inspection, mocked provider/stream checks, real local Wrangler behavior,
browser rendering and authorized private hosted verification distinct in reports.
This documentation review does not constitute a new runtime audit.
