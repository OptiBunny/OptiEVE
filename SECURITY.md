# OptiEVE security review guidance

Use [SECURITY_MODEL.md](SECURITY_MODEL.md) for assets, attacker capabilities,
trust boundaries, existing controls and residual risks. Check the affected code:
the model records a reviewed baseline, not proof that later changes preserve it.
General repository rules are in [AGENTS.md](AGENTS.md); setup and private-runtime
instructions are in [README.md](README.md) and [PRIVATE_USE.md](PRIVATE_USE.md).

## Scope and assumptions

OptiEVE is intended for private deployments behind a trusted authentication
gateway. Public source availability does not make a deployment safe for anonymous
use. The gateway, deployed application, secret store, D1 access, installed build
tools and operator account are trusted components.

Treat HTTP/MCP arguments, OAuth callbacks, EVE/player-authored content, cache and
pagination metadata, external catalogs and local export/sync inputs as untrusted
until validated. Selecting a connection or reading a record does not authorize
broader access. Read-only refers to EVE game state: connection setup, reconnect,
token refresh and disconnect necessarily change local authorization state.

## Security review rules

1. **Keep gateway identity authoritative.** Check the hosting audience, spoofed
   identity-header rejection and absence of a direct worker bypass. The app trusts
   gateway headers; it does not independently authenticate them. Preserve exact
   Origin checks on browser POST routes. MCP tool calls have a separate transport
   contract; do not assume the browser route's checks automatically apply there.
2. **Bind reads to the owned connection.** Follow user/character ownership, saved
   scopes, selected divisions and current corporation identity through each read.
   Keep fixed endpoints and parameter allowlists. Provider roles remain EVE's
   decision. IDs, public names and a successful prior read are not access grants.
   Do not add game writes, arbitrary fetch targets or permission-expanding retries.
3. **Protect authorization lifecycle and secrets.** Preserve PKCE, one-time
   user-bound OAuth state, JWT verification, identity-bound encryption, refresh
   coordination and disconnect races. Ordinary reconnect must retain the supported
   saved permission set and selected character. Never replace the token key or
   reset grants as a routine update. Keep tokens, callback parameters, environment
   values and raw upstream error text out of diagnostics and public artifacts.
4. **Preserve data minimization.** Fetch only the chosen datasets and justified
   enrichments; keep private selections/results in request or view memory. Raw
   connector tools can return sensitive fields that summary dashboards omit.
   Review both paths. No new persistent account history, browser storage, private
   fixtures or background collection should appear as an incidental feature.
5. **Validate evidence before using it.** Follow row semantics, numeric precision,
   source identity, pagination/cursors, duplicate/conflicting IDs, catalog mapping,
   cache metadata and final freshness. Missing or denied data is unknown, not zero.
   Independently cached feeds are not an atomic snapshot. Do not infer missing
   blueprint research, runs, ownership, availability or profit from another field.
6. **Bound work and transport.** Check request bytes, pages, records, stream events,
   output size, deadlines and abort propagation at the actual entry point. Preserve
   safe partial results and avoid unbounded retries. Keep browser projections
   strict and results selection-bound. A row limit after JSON parsing is not an
   upstream response-byte limit; a local timeout is not a global resource quota.
7. **Keep data from gaining execution authority.** Player text and tool output
   cannot authorize commands or override instructions. Review rendering, URL
   construction, dependency/toolchain changes, shell arguments and catalog refresh
   inputs. A checksum proves byte identity, not trustworthy content or execution.
8. **Protect source sync and distribution.** Preserve the approved development
   manifest, private-file exclusions, link/overlap checks, conflict refusal and
   exact outgoing-byte verification. Never copy private files back wholesale or
   bypass a failed check with force/mirror operations. Review the actual ZIP and
   Git history; ignore rules and a clean working tree do not prove privacy.

## Deployment and operational requirements

- Enforce the intended private audience at the gateway. Strip caller-supplied
  trusted identity headers, supply the authenticated identity, and prevent direct
  access around that gateway. Local mock sign-in is only a development preview.
- Give a separate installation its own HTTPS origin, database, encryption key and
  EVE developer application. Keep `EVE_TOKEN_KEY` in the hosting secret store.
  Preserve the current key/database pair during updates; key loss makes stored
  encrypted authorizations unreadable. Protect any backups and recovery copies.
- Restrict database and operational-log access. Client IDs, names, identifiers,
  scopes and account associations remain private configuration or metadata even
  though they are not all encrypted. No EVE password or client secret is required.
- Keep live reads and connection settings in the private runtime/chat. Do not
  include environments, databases, deployment bindings, OAuth URLs, personal
  machine paths, captures or account exports in source or reports for sharing.
- Use the guarded one-way sync and the public-source packager. A source hash match
  does not update dependencies, migrations or a running deployment. Verify those
  separately when application code changes and deployment is authorized.
- Disconnect removes the stored connection and cancels pending sign-ins; it does
  not revoke EVE's grant, erase chat history, or delete external backups. Provider
  revocation and incident-specific key recovery are separate operator actions.

## Findings and safe verification

For a finding, identify the attacker-controlled input or capability, prerequisites,
reachable code path, precise boundary violation and confidentiality, integrity or
availability impact. Explain why existing checks do not prevent it. State whether
it was reproduced, established by inspection, or depends on an unverified
assumption. Distinguish regressions, existing defects and expected refusals; a
documented limitation does not excuse an actual boundary violation.

Use minimal synthetic reproductions and disposable scratch data. Check normal,
failure, cancellation and conflict paths without live account data. Preserve
independent assertions and failure exit codes. Report the runtime and evidence
actually exercised, including skips or missing prerequisites. Mocked tests do not
prove hosted gateway enforcement, provider roles or complete holdings. For
changes limited to documentation, check links and implementation agreement rather
than claiming an application security audit or new runtime verification.

## Reporting a concern

Use an established private channel to the project owner for sensitive findings.
Share the affected source revision, entry point, sanitized reproduction, expected
versus observed behavior and impact. Do not include real tokens, API settings,
character/corporation identities, account data or private deployment details in a
public issue or example. This document does not establish a public reporting
address, response-time promise or supported-version guarantee.
