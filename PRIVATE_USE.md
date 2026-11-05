# Shared source, separate private runtime

The development checkout supplies the code for both public distribution and private use. The private runtime is a separate sibling directory named `OptiEVE Private` by default. It starts with sanitized source and no credentials, account data, dependency installation or deployment.

## Create or update the private source

From the development checkout, with Node.js and Git available:

```sh
node scripts/sync-private-source.mjs
node scripts/sync-private-source.mjs --check
```

Use `--target` with a directory outside development to choose another private location. Use the same target for future sync and check commands. The default sibling location follows the development directory's parent; no personal absolute path is stored in public source.

Sync copies the validated current source, including uncommitted changes. It uses a private manifest to identify managed files, refuses conflicting edits and removes only unchanged, previously managed source that development has deleted. The private manifest must match an approved source manifest in development's `outputs/private-sync/manifests/`; these records contain generic source filenames and hashes, with no private data or target paths. Keep those records when moving the development directory. Missing or altered records stop the sync rather than authorizing deletion.

Sync preserves private environment files, databases and other unmanaged runtime files. Only the private `project_id` in `.openai/hosting.json` is retained as an intentional configuration difference; the remaining hosting configuration follows development.

The private copy has no copied Git history or remote. Its `.eve-private/` marker also prevents the public source tools from packaging it. Public releases always come from development. The manifest records source hashes, not credentials or private account data.

## Use the second chat

Start the private-use chat with:

> Read AGENTS.md and PRIVATE_USE.md. Use the sibling OptiEVE Private folder as the runtime, keep this development folder source-only, and preserve code parity through the provided sync command. Set up only the private connection state needed for EVE access. Use the established development PR workflow for repository changes; do not initialize Git in this runtime.

The runtime chat should install dependencies and build inside the private directory. Keep credentials in the private environment or hosting secret store, never in source or chat messages. Keep any private deployment identity in that runtime's configuration. Both source folders carry the same instructions.

`pnpm dev` supplies a loopback mock sign-in for preview. Real EVE access requires the documented Cloudflare Workers/D1 runtime, an HTTPS origin and callback, the token key, and a trusted authentication gateway. Source synchronization does not provision these, authorize an EVE character, apply migrations, rebuild, restart a process or publish a hosted update.

## Update policy

Completed development changes must be checked, synced to the private source and checked for parity. Application code has one source of truth; private fixes should be recreated in development using synthetic data, then synced forward. Do not reverse-mirror private files into development.

When a private instance is running, finish the required install/build/migration/restart or authorized deployment steps there and verify it is serving the updated version. Preserve the existing encryption key and database. A code hash match alone is not proof that a running deployment has updated.

This is a command-driven workflow, not a background watcher. If another process or chat has changed private code, stop and reconcile the conflict instead of overwriting it. Report any pending runtime update honestly.

## GitHub PR preparation

`OptiEVE-dev` is the canonical development repository; `OptiEVE` receives reviewed
public source. Both keep the complete sanitized source layout, including tests,
scripts and documentation. The private runtime remains Git-free. Follow the
[PR rules in AGENTS.md](AGENTS.md#github-pull-requests).

1. Make the code-only change in canonical development with synthetic data. Run
   the public-source check and relevant validation, then the guarded private sync
   and parity check described above. Preserve the approved local sync manifests;
   they are deliberately excluded from repository publication.
2. Use a sanitized Git checkout whose history is based on the current
   `OptiEVE-dev` remote `main`. If the canonical local checkout has older or
   unrelated history, leave its files, index, refs and remotes intact and use a
   separate staging checkout. Compare the remote base with the canonical source
   baseline before transferring changes; reconcile remote changes and local edits
   explicitly rather than replacing either tree or treating absence as deletion.
   Use the last aligned source snapshot as the baseline, not the canonical
   checkout's older Git diff, so accepted remote-only changes are not reverted.
   Apply any reconciled source changes back to canonical development and repeat
   the relevant validation and guarded sync before recording final PR evidence.
3. Create `codex/<topic>-YYYYMMDD` from that current remote base and transfer only
   the reviewed source delta. Preserve exact file bytes and verify the staged
   diff, including each deliberate deletion. Do not copy `.git`, private
   environments, runtime files, outputs or local manifests, and do not use
   force-push or history rewriting to join old histories.
4. Push the feature branch and open its PR into `main`. Describe the behavior,
   validation and remaining limits. Record the current head commit for checks and
   both code and security reviews. Resolve findings and obtain reviews again
   after changes, including conflict resolution; do not describe pending review
   as a pass. Use ordinary merge commits unless the user requests another strategy.
5. After development source is accepted, prepare a separate sanitized promotion
   PR from the public repository's current `main` and link the two PRs. Review
   that exact diff and introduced history; never publish the private runtime or
   carry unrelated local history into either repository. Verify source parity
   against the accepted result and report any unresolved drift.

PRs and merges do not install dependencies, migrate a database, restart a runtime,
deploy the private app or publish a release. Follow the existing authorization and
runtime-update rules for those actions. Documentation-only updates need link and
source/parity validation, not an application rebuild or live account read. This
workflow does not install CI, branch protection, auto-merge or background sync.

## Retention

Retain only what the current connector needs: private runtime settings, Client ID, encrypted access/refresh tokens, user/character/corporation identifiers, display names, scopes, expiry/refresh metadata and temporary OAuth state. No EVE password or client secret is needed. Orders, assets and wallet data are fetched on demand; do not add persistent trading datasets or personal exports by default.

Private tool responses may remain in the calling chat's history. Use the private-use chat for account reads. Folder separation does not restrict what another authorized chat can access on the computer.

Manufacturing assessments, comparisons and combined plans use existing read permissions. Keep private market/facility choices and planning results in the private workspace/chat; do not save them as development fixtures. The browser keeps choices and results in memory only. A combined plan is conditional planning, not a purchase or installation, and does not credit future output or sales as current resources. The `/demo` route uses synthetic fixtures without any connection or account reads and is suitable for development verification. Catalog refresh belongs in sanitized development, followed by the normal guarded sync and authorized runtime update; never run it from the private runtime.
