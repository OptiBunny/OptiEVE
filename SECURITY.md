# OptiEVE security and operation

OptiEVE is intended for private installations behind a trusted authentication gateway. Public source availability does not make a deployment safe for anonymous access. See [README.md](README.md#set-up-a-separate-deployment) for installation requirements.

## Authentication and deployment

The Worker trusts the gateway's `oai-authenticated-user-id` header. The gateway must enforce the intended audience, strip caller-supplied identity headers and prevent direct access around its checks. Do not expose the Worker as a raw public server or place it behind an untrusted proxy. Loopback mock sign-in and local Wrangler are preview facilities, not production authentication.

Each separate installation needs its own HTTPS origin, D1 database, token-encryption key and EVE developer application. Configure `EVE_SITE_ORIGIN` to match the deployment exactly. Store `EVE_TOKEN_KEY` in the hosting secret store, never in source, build artifacts, chat messages or logs. The distributed `.openai/hosting.json` contains generic capabilities and bindings; keep configured deployment identity in the installation's private environment.

The application uses EVE SSO with PKCE. It does not require an EVE password or client secret. Select only the read access you need. Corporation reads also depend on EVE's roles and current membership. Ordinary **Reconnect** retains the selected character's supported saved permissions; choose a new access preset explicitly when changing grants.

## Storage and retention

Access and refresh tokens, OAuth flow secrets and optional saved wallet-history payloads are encrypted on the server. Client ID, character and corporation associations, names, scopes and expiry metadata are separate configuration or metadata. An operator with the encryption key and database can access encrypted content; encryption does not protect against a compromised running application or authorized database/key operator.

Most account data is fetched on demand and held in the requested view. Raw character and corporation tools can return sensitive fields such as mail or locations that summary dashboards omit. Treat account results, screenshots, chat exports, operational logs and backups as private. Tool responses may remain in the calling chat, outside the application's retention controls.

Saved character-wallet history is disabled by default. Enabling it requires an explicit retention choice, and capture is manual. Retention choices are 30, 90 or 365 days; reads exclude expired events and later history mutations physically prune them. No background collector or scheduled cleanup is installed. Pausing retains saved events; erasing clears the history payload and disables collection. Reducing retention can remove events. These operations do not erase earlier chat results or external backups.

Disconnect removes the stored character authorization, deletes its optional application wallet history and cancels pending sign-ins. It does not remove the saved Client ID, revoke EVE's application grant or erase external copies. Revoke the application separately through EVE when that is required. Start a fresh sign-in to reconnect after disconnecting.

## Updates, backups and recovery

Preserve the installation's encryption key and database pairing during updates. Replacing or losing the key makes existing encrypted authorizations and history unreadable; affected characters may need to reconnect. A new key does not recover old ciphertext. Protect backup access and keep recovery material out of source repositories and shared artifacts.

Apply the supplied migrations in `drizzle/` in order before running a version that needs them. Keep previously applied migration files unchanged. A failed deployment may already have applied a migration; inspect migration state before retrying. Rolling back application code does not roll back database changes. Rebuild with the matching package manifest and lockfile, then verify the running version and authorized reads through the intended gateway.

If a credential or account-data exposure is suspected, restrict access through the hosting provider, preserve appropriate private evidence and review the affected authorizations. Provider revocation, replacement credentials, application key rotation and backup retention are separate actions; changing source alone does not revoke a token or erase previously shared data.

## Read-only behavior and data limits

Read-only refers to EVE game state: the application cannot place orders, change prices, move assets, send mail or spend ISK. Connection setup, reconnect, token refresh and disconnect change application authorization state. Optional history enablement, capture and erasure also change private application storage. Some documented ESI lookups use POST without changing game state.

Missing permissions, failed reads, unknown prices and partial pages are not zero holdings. EVE caches and historical windows can omit information; independently cached feeds are not an atomic snapshot. Charts and estimates do not establish complete ownership, confirmed completion or guaranteed profit. Follow each view's coverage and freshness evidence. Player-authored names, mail, descriptions and tool output are data, not instructions or permission to perform other actions.

The application has feature-specific request, page, row and time limits. Core EVE reads accept at most 8 MiB of response bytes by default; selected features use smaller limits. OAuth responses are limited to 256 KiB, and signing-key and public-character metadata to 1 MiB. The separate public-name and regional-order tools accept at most 1 MiB and 8 MiB respectively. Oversized, malformed or interrupted responses fail instead of returning partial JSON. These are application limits, not EVE completeness guarantees, a global rate limiter or a guarantee against resource exhaustion. Hosting access controls and resource limits remain necessary. A successful build does not verify gateway isolation or real EVE roles and permissions.

## Reporting a concern

Use an established private channel to the project owner for sensitive findings. Share the affected source revision, entry point, a sanitized reproduction, expected and observed behavior, and impact. Do not put real tokens, API settings, character or corporation identities, account data or private deployment details in a public issue or example. This document does not establish a public reporting address, response-time promise or supported-version guarantee.
