# OptiEVE

A private, read-only overview and connector for EVE Online character and corporation data. It uses EVE SSO authorization code flow with PKCE and exposes sixteen tools through `/mcp`:

| Tool | Data returned |
| --- | --- |
| `connection_status` | Connected characters, granted scopes and setup URLs |
| `read_private_data` | One page of orders, assets, wallet transactions or wallet journal |
| `read_character_data` | An allowlisted character dataset, with dataset-specific parameters and pagination |
| `read_corporation_data` | Wallet balances, assets and name/location lookups, order history, contracts and items/bids, industry jobs, blueprints, facilities, structures, mining extractions, freelance jobs, projects and your selected character’s contribution |
| `resolve_names` | Public EVE names for supplied IDs |
| `public_market` | One page of public regional orders for an item |
| `manufacturing_item_search` | Bounded public item search with recipe IDs and official catalog provenance |
| `manufacturing_recipe` | Official manufacturing inputs, output units, required skills and base time |
| `manufacturing_catalog_status` | Latest official SDE manifest compared with the pinned catalog |
| `manufacturing_requirements` | Deterministic material quantities from runs, ME and an explicit facility multiplier |
| `manufacturing_market_history` | Public regional history with cache evidence; not station liquidity |
| `manufacturing_industry_costs` | Manufacturing system index and requested input adjusted prices |
| `manufacturing_station_quote` | Exact NPC-station depth, minimum fills, owned-order exclusions and expiry |
| `assess_manufacturing` | Owner-scoped stock, blueprint, skills, funding, market depth and conditional economics |
| `manufacturing_compare` | Up to five alternatives under one context and completion-time freshness check |
| `manufacturing_plan` | Combined production and shopping plan with shared stock, wallet, copy runs and depth |

The application cannot place orders, change prices, move assets or spend ISK. Corporation reads require the appropriate scopes and character roles.

## Manufacturing planning in chat

The Manufacturing workspace supports public product search, owned blueprint pages, individual assessments, candidate comparison and a combined production/shopping plan. Select the connected character, personal or corporation resources, market, facility and explicit cost assumptions before loading. Blank costs mean unknown; enter zero only when that assumption is intended. Inputs and results remain in memory and clear when the context changes or the workspace is left. The same operations are available through the MCP tools using existing read permissions.

Comparison accepts one shared context and up to five jobs. Rankings compare modeled instant-sale economic profit for qualifying alternatives at their selected batch sizes; they are not profit-per-hour rankings or a jointly funded portfolio. The combined plan allocates stock and verified blueprint-copy runs in submitted job order, totals upfront cash against one wallet, and quotes aggregated material deficits and output quantities against shared market depth. It does not count planned output as available input stock, future sales as funding, or an original blueprint as multiple concurrent job slots. Missing costs, incomplete depth and uncertain evidence remain visible.

Open `/demo` to explore the same workspace with clearly labeled synthetic fixtures, including missing evidence and limited-resource scenarios. It makes no EVE, account-status or manufacturing API requests and stores no inputs or results. Demo values are examples, never live prices or account evidence. The deployment's existing audience policy still applies to this route.

`assess_manufacturing` takes one blueprint and at most twelve material types. Corporation resources require an explicit wallet division and, when using owned stock, explicit hangar divisions. Personal funds are never substituted. Available funds use the received numeric wallet balance's decimal representation, floored to whole ISK cents with integer arithmetic; sub-cent fractions cannot increase affordability. Malformed, negative, nonfinite or out-of-range balances remain unknown. Select the market NPC station and manufacturing system separately; an optional accessible structure can verify its system, but does not establish manufacturing-service access, rigs or fees. Stock may be selected at verified facilities, observed offices or containers with validated parent chains and inherited hangar divisions. The default private page budget is three; callers may request up to fifty pages and 50,000 asset rows. The workspace exposes these bounds under Data read limits, alongside a public market-page limit of one to four (default two). Larger limits remain subject to the shared deadline and do not promise complete coverage. Unknown pages, missing ancestors, cycles, unsupported selected storage and stale data cannot establish zero stock or affordability.

Supply the owned blueprint item and page, or explicitly choose a prospective blueprint. Verified owned ME and copy runs override caller claims. Prospective acquisition, blueprint availability for a new job, facility access and hauling remain conditions. Fees and overhead use decimal strings: omitted or null values mean unknown, while an explicit zero is a scenario assumption. Installation may use a supplied quote or the current system index and adjusted input prices with explicit cost/tax multipliers. Recipe quantities use conservative whole-job upward rounding; estimated item value uses undiscounted recipe inputs. Owned inputs retain their forgone net sale value; replacement cost and additional cash are shown separately. Instant-sale and hypothetical listed-sale results are separate, and no estimate establishes realized profit or a guaranteed sale.

Every assessment has a shared 55-second deadline, checks account ownership and corporation consistency, and rechecks evidence expiry at completion. Depth uses exact-station public orders, effective minimum quantities and explicit own-order exclusions. Ranged bids at other locations are omitted. Regional history is context, not station demand. Incomplete exclusions, insufficient depth, missing costs, or an outdated/unverified recipe catalog keep results conditional. Private results remain in request memory and in the calling chat's normal result history, with no application archive or background refresh.

The public catalog is a derived snapshot of [CCP's official SDE](https://developers.eveonline.com/static-data/tranquility/latest.jsonl), with build, release and content hashes in `app/data/manufacturing-catalog.json` and attribution in the adjacent NOTICE. The runtime only checks the small latest-build manifest; it never downloads or replaces recipes automatically. The explicit refresh workflow stages public data outside development, summarizes semantic changes and provenance-only updates, validates the catalog and arithmetic with a reviewed compiler, and applies through the guarded private-source sync:

```sh
node scripts/refresh-manufacturing-catalog.mjs --check --validation-dir /path/to/external-installed-validation-copy
node scripts/refresh-manufacturing-catalog.mjs --apply --validation-dir /path/to/external-installed-validation-copy
```

The validation copy must contain the current package/lockfile and installed pinned TypeScript runtime, and must be outside both source and private runtime. Optional `--archive` selects an already downloaded official JSONL archive; `--target` selects a different private sibling. Check mode leaves canonical source and private files unchanged. Apply validates before replacing the catalog, then runs public checks and guarded source sync/check. A private conflict after catalog replacement is reported as a partial update; reconcile it before deploying. This command does not install dependencies in development, deploy, publish, create a repository or schedule background updates. Review the diff and complete the normal full build/runtime validation before deploying the refreshed source.

## Operations overviews

**Open orders** adds a personal response or one corporation page of order-side counts, top item types, a reported-expiry chart and a searchable, sortable table. Personal results explicitly exclude corporation-placed orders. ESI omits optional boolean fields when false, so an omitted buy/sell flag means Sell, including on the Overview card; malformed present values are rejected. Unit prices preserve the decimal representation received from the API; the dashboard does not calculate aggregate notionals, fills, proceeds or profit. Expiry is the reported issue time plus duration, not proof an order has disappeared. Tables keep quantities per order, with no mixed-item quantity total. Issuer identities, locations and private names are omitted; item labels use the pinned public catalog.

**Blueprint analytics** adds original/copy/original-stack composition, material/time-efficiency distributions and top blueprint types for one selected personal page or all available corporation blueprint pages. Charts count records, while the searchable table distinguishes stack units and each copy's remaining runs. Original and copy quantity sentinels are interpreted explicitly; contradictory rows are rejected. No total across unrelated copy runs, production output, available job slots, valuations or location inference is calculated. Row numbers are response-local, and item/location identifiers and flags are omitted. The existing raw blueprint libraries remain available separately.

These two dashboards reuse the saved market and blueprint read grants, without changing authorization. Corporation market reads remain subject to EVE's Accountant/Trader access and blueprint reads to Director access. Loads are manual, new loads replace prior results, and changing owner or leaving the view clears data. Orders reject responses above 5,000 rows. Personal blueprints and each corporation blueprint page accept at most 1,000 records. Both use strict browser validation, cancellation and visible cache evidence; no history or settings are saved.

The normal corporation blueprint load first collects the blueprint pages ESI advertises, then compares them with corporation assets using the existing asset read permission. Progress distinguishes the two stages and cancellation discards the load. Reads run sequentially under one shared 55-second deadline, with at most 50 pages and 50,000 received records per source and 50,000 combined unique blueprint records. These budgets may stop before the provider's last page. The blueprint-only collection endpoint remains available. Identical duplicates count once with an inconsistency warning; malformed or conflicting pages, changing corporation or pagination, changed within-source cache snapshots, denied/rate-limited reads and failures stop that collection. Each accepted subset remains explicitly limited. Exact tables use bounded local pagination.

**Blueprint asset reconciliation** can reveal additional items omitted from the blueprint endpoint. Raw item identifiers join the two sources only in server request memory and never enter the browser projection. Blueprint-only records are retained; absence from the assets response does not establish lost ownership or an active industry job. Matching identities with conflicting type, copy flag or physical quantity remain flagged, with the blueprint endpoint's evidence preserved rather than overwritten. Each source has independent coverage, consistency and completion-time freshness; their cache timestamps need not match, and the comparison is not an atomic inventory snapshot.

Only types classified in blueprint category 9 by the pinned public SDE qualify as assets-only blueprints. Classification does not depend on names or manufacturing recipes. Unmapped asset types remain unclassified. Additional-item charts distinguish copy and non-copy records using ESI’s optional-boolean contract: an omitted copy flag means false. The bounded table shows the reported quantity and explicitly unknown material efficiency, time efficiency and remaining runs. A false or omitted asset copy flag does not establish an original blueprint, and absent research values never mean zero or unlimited runs. Research-efficiency charts continue to cover blueprint-endpoint records only. Source-overlap and combined-type charts count records, not mixed-item quantities, usable stock, production capacity or value. No extra name or location lookups, saved inventory history or new scopes are introduced.

**All available API pages is not a complete owned library.** ESI has historically imposed a 25,000-blueprint database ceiling, and some container-stored blueprints may be omitted even below it. The current schema does not guarantee a numeric ceiling, so the app follows advertised pages within its own budgets and warns when the historical threshold is reached. No asset scan, missing research data or additional ownership is inferred. See the [official provider-limit issue](https://github.com/esi/esi-issues/issues/1083#issuecomment-503512769), [container-omission issue](https://github.com/esi/esi-issues/issues/611#issuecomment-408416331) and [ESI cache-snapshot guidance](https://developers.eveonline.com/docs/services/esi/best-practices/).

**Inventory** adds personal and corporation asset-page analytics. Category donuts, group bars and reported-location bars count asset records; a record can represent a stack or one item. The searchable type table shows quantities summed only within that type, plus singleton and blueprint-copy metadata. Omitted optional copy flags mean false under ESI’s contract; this does not establish an original blueprint or its research. Filters and table pagination are local to the loaded page. Type/group/category labels come from the checked public catalog; unmapped types retain their IDs and unknown classification. Location IDs and kinds remain as reported: the app does not resolve container ancestry, infer a station, fetch custom item names, or estimate net worth, value, volume or available manufacturing stock. One provider page replaces the previous page, with a 1,000-row application limit and explicit paging/freshness.

**Industry jobs** adds personal and corporation job dashboards: reported-status composition, activity counts, an active-job end-date chart, a filterable timeline and exact UTC job dates. The timeline shows the first 20 matching jobs, with all matching jobs available in 100-row table slices. Summary charts cover the full returned response; local filters affect only the timeline and table. The optional completed-jobs read requests EVE's available history window, up to 90 days. Personal jobs use one unpaged response; corporation jobs use an explicit page. A reported ready job is different from a delivered job, and a past end time does not establish completion. Runs stay per job, with no mixed-activity output total, cost or profit calculation. Installer, completing-character, facility/location and blueprint-item identifiers are omitted. The application rejects responses above 5,000 rows rather than truncating summaries.

Both views reuse existing asset/industry read grants. Corporation access remains controlled by EVE roles (Director for assets and Factory Manager for jobs). There are no new scopes, credentials, history tables, automatic reads or game-state writes. These are web dashboards; the existing sixteen MCP tools are unchanged. Their shapes and limits follow the [dated ESI schema](https://esi.evetech.net/meta/openapi.json?compatibility_date=2026-10-31); activity labels come from the pinned official SDE, with unknown numeric activities retained explicitly.

**Skills & training** adds a character-manager dashboard for reported total and unallocated SP, skill-group and level charts, a searchable skill list, attributes and remap metadata, and a reported queue timeline with exact UTC dates. Trained and active levels remain separate, including expert-system boosts. The chart does not infer active training, current SP, completion or a precise training rate. Skills may lag until the next EVE login, and queue dates can be absent or already past. Skills, queue and attributes load independently under their existing read scopes, with a shared deadline and per-section freshness. Responses above the application limits of 2,000 skill rows or 1,000 queue rows are rejected rather than silently truncated.

**Wallet activity** shows daily incoming/outgoing ISK, net cash flow and fixed activity categories for one explicitly selected journal page. Choose either the character wallet or one corporation wallet division. Amounts are summed with exact integer arithmetic on the received JSON numbers' decimal representations; prior provider or JSON parsing precision cannot be recovered. Missing amounts remain unknown, and days without returned rows are omitted. Transfers are included as movements, so these charts do not establish profit, wealth or historical balances. Loading another page replaces the chart; no pages or accounts are combined. The application accepts at most 2,500 rows in one response. Raw journal entries, counterparties, descriptions, balances and tax fields are excluded from this dashboard's response.

The **Industry → Mining ledger** view adds a daily bar chart for one selected material type across the displayed batch. Quantities for different types are never added together. The chart keeps real UTC date spacing, distinguishes reported zero from missing days, and offers an exact-value table. It uses the existing response and optional public labels, with no extra mining request or history store.

These dashboards fetch only on request, hold results in memory, and clear them when selections change or the workspace is left. They reuse granted read permissions; no new scopes, database tables, write operations or credential settings are introduced. Current journal/mining windows and optional queue fields follow the [official ESI schema](https://esi.evetech.net/meta/openapi.json?compatibility_date=2026-10-31); freshness follows [CCP's caching guidance](https://developers.eveonline.com/docs/services/esi/best-practices/).

The **Overview** workspace shows one selected character at a time. Click **Load overview** to fetch wallet balance, skill queue, personal market orders, industry jobs, contracts and freelance jobs. Each card shows its own coverage and ESI cache information. Refreshes are manual; switching characters, workspaces or pages clears displayed results and cancels the browser request. Results are held in memory, with no account-data history, browser storage, background polling or new database tables.

The **Corporation operations** overview separately summarizes wallet balances, contracts, industry jobs, active projects, moon extraction schedules and freelance jobs. Wallet totals cover only returned divisions and show how many of the seven divisions are available. In **Connections**, select the optional reads you need:

| Option | Additional read scope | Access requirement |
| --- | --- | --- |
| Corporation contracts | `esi-contracts.read_corporation_contracts.v1` | Authorized corporation access; ESI enforces membership |
| Corporation industry jobs | `esi-industry.read_corporation_jobs.v1` | Factory Manager role as well as the scope |
| Corporation projects | `esi-corporations.read_projects.v1` | Authorized corporation access; detail reads only the selected character’s contribution, never a contributor list |
| Corporation blueprints | `esi-corporations.read_blueprints.v1` | Director |
| Corporation facilities | `esi-corporations.read_facilities.v1` | Factory Manager |
| Corporation structures | `esi-corporations.read_structures.v1` | Station Manager |
| Corporation mining extractions | `esi-industry.read_corporation_mining.v1` | Station Manager; the app exposes extraction schedules, not observer or miner records |
| Corporation freelance jobs | `esi-corporations.read_freelance_jobs.v1` | Project Manager; no participant list or participant details |

Connections offers **Character only** and **All read-only access** presets. Character only is the default; All read-only access explicitly selects all currently supported character and corporation reads. **Advanced** contains the nine individual corporation choices. The scope list reflects the selection; register those scopes in your EVE developer application before continuing to EVE sign-in. Presets can add a character or deliberately replace an existing character's requested access. Registering scopes does not grant corporation roles or update saved grants. The app does not request member tracking, container logs, contributor lists or game-changing permissions. [CCP SSO and application scopes](https://developers.eveonline.com/docs/services/sso/), [official ESI schema](https://esi.evetech.net/meta/openapi.json).

Use **Reconnect** beside a saved character to review and retain that character's existing supported read permissions. This preserves older character scope subsets and partial corporation groups without silently adding new permissions. Selecting Reconnect opens a review; it does not start authorization. Continue only after reviewing the displayed scope set, and choose that same character on EVE's sign-in page. Changed permission snapshots, a different character or unexpected returned permissions fail safely. Choose a new preset explicitly when you want to change access instead.

These overviews bound each dataset to one response. Numbered pages show partial or unknown coverage when appropriate; projects and corporation freelance jobs show the first cursor batch with explicit coverage. Denied, missing, malformed, rate-limited and timed-out reads have explicit states without fabricated zeros. Sequential reads stop after an authorization change, rate limit or a 55-second deadline. Corporation identity is refreshed for each corporation read; a change during the overview discards the mixed results.

The separate **Corporation** tab lets you browse wallet divisions, corporation assets, market order history, contracts, blueprints, facilities, structures, active projects, mining extractions and freelance jobs. Contract items, auction bids and project details load only when selected. Rows are limited to 100 per displayed batch. Use **Load next batch** for available pages or cursors, and **Back to previous view** to fetch the previous selection again. These are fresh reads of a changing feed, not a saved snapshot. Each view shows coverage and source freshness. Wallet balances and order history reuse existing wallet/market read permissions; the other views use their optional permissions above.

**Mining extractions** shows reported structure/moon IDs and UTC extraction-start, chunk-arrival and natural-fracture times. Schedule classifications use the load time; they do not confirm that ore exists, a chunk was fractured, or mining occurred. The app does not fetch observers or miner activity. **Freelance jobs** shows the returned job state, progress and any reported initial/remaining reward reserve. Reward reserves are not your earnings or a profit calculation, and progress units may differ between jobs. Personal freelance coverage is limited to the selected character's active participation list; corporation browsing uses explicit cursor batches. No participant roster, job description or extra detail read is fetched.

Auction rows offer **Load bids** alongside **Load items**. Bids show the provider's reported amount and date, without bidder identities. Paging stays bound to the selected contract. A bid is not proof of winning, payment, settlement or profit; no missing bid is replaced by zero. This view reuses the corporation contract read permission and performs no bidding action.

**Load progress** combines project progress, the selected character's own contribution and a bounded **Project objective** summary. The summary displays supported objective kinds, selected public type/group filters and reported schedule or contribution settings. Creator identities, contributor lists, descriptions, private docking locations and identity filters are omitted. Missing, unsupported or malformed objective details are marked explicitly; omitted filters mean the summary is incomplete, so review the full objective in EVE before acting. No contribution roster or extra permission is requested.

The **Assets** view reads one corporation asset page and displays up to 100 rows per slice. **Load details** rechecks that the selected item is still in that page before querying its custom name and available coordinates. Each step rechecks current corporation membership; mixed results are discarded. Names and coordinates use the existing corporation assets read permission and require Director. Coordinates can be unavailable or provider placeholders; they are not an automatic station, container or physical-location resolution. Neither the asset browser nor its details build a persistent inventory archive.

**Include public type and system names** is off by default. When selected, loading a view performs at most one public lookup for up to 200 unique type/system IDs derived from its displayed rows. Private item, character, corporation and container/location IDs are excluded; no EVE bearer or personal API settings accompany the lookup. Missing or failed name lookups preserve the original IDs and report limited name coverage. Names stay plain text. Identifiers retain exact digits without thousands separators, and optional structure schedule timestamps are displayed in UTC.

The **Blueprint library** distinguishes originals, copies and stacks of fresh originals, and shows material/time efficiency and reported copy runs. Type, item and location IDs remain explicit; no extra name or asset reads run automatically. The **Facilities** list provides the reported facility, type and solar-system IDs; it is not a full structure inventory or a production-cost estimate. **Structure fuel & services** shows the provider's state, fuel-expiry and transition timestamps plus reported services. Missing fuel dates or services stay unavailable; no fuel quantity or guaranteed shutdown time is inferred. **Market order history** covers cancelled and expired corporation orders in EVE's available history window, up to 90 days. Remaining quantities and quoted prices are not transaction proceeds, realized fills or profit.

Wallet cash, buy-order commitments, escrow and sell asking values remain distinct. The overview does not calculate profit or net worth, infer completed training from a schedule, or treat a past industry end time as confirmed delivery. No mail, current location or member activity is fetched by these views. All development fixtures use synthetic records; actual grants, roles and deployed authentication still need checking in the private installation.

Character access covers finances and inventory, skills and clones, location and ship, industry and planetary colonies, contracts and fittings, mail and calendar, contacts and standings, combat, fleet membership, accessible structures and newer character activities. `connection_status` lists the supported datasets, required parameters and granted scopes. To add newly supported scopes, explicitly choose All read-only access or a custom selection and authorize again; ordinary Reconnect preserves existing supported permissions. Requests fetch data on demand; there is no account-data archive.

The explicit endpoint catalog is reviewed against [CCP's ESI OpenAPI schema](https://esi.evetech.net/meta/openapi.json). Alongside GET reads, its POST requests perform documented lookups: character asset names/locations and communication-cost estimates, corporation asset names/locations, and public EVE names. These lookups do not modify game state or require action scopes. EVE's `esi-planets.manage_planets.v1` scope supplies planetary reads; the connector exposes no planetary write operation. No mail sending, contact editing, fleet commands or other game-changing operations are implemented.

## Clones and implants

The **Clones & implants** dashboard loads the selected character’s jump clones and active implants under their existing read permissions. Each feed has its own permission, error and cache status. Active implants remain separate from implants stored in jump clones; independently cached responses are not an atomic snapshot.

The jump-clone table and implant-count chart show response-local clone rows, reported location IDs/kinds and installed implant type entries. Loading this view reveals those clone and home-location IDs. Custom clone names and raw jump-clone IDs are omitted, and no location/name resolver is called. Implant labels come from the pinned public catalog, with exact type IDs and an explicit fallback for unmapped types. Repeated implant type entries remain reported occurrences rather than silently disappearing.

Reported clone-jump and station-change dates are shown as timestamps. Missing dates and optional home-location fields stay unknown. The dashboard does not infer jump readiness, clone capacity, implant bonuses, value or whether a facility is accessible. One load accepts at most 100 jump clones and 64 implant entries per clone or active-implant response; oversized or malformed feeds fail explicitly. Loads are manual, cancellable and clear on refresh, character changes or leaving the view. No account history, new permissions or game writes are added. See the [dated ESI schema](https://esi.evetech.net/meta/openapi.json?compatibility_date=2026-10-31) and [CCP’s jump-clone guide](https://support.eveonline.com/hc/en-us/articles/203217202-Jump-Clones) for provider fields and the separate in-game requirements.

## Reputation and loyalty

The **Reputation** tab loads one selected character's **Faction warfare**, **NPC standings** or **Loyalty points** when requested. These views reuse the existing character read permissions; this feature does not add scopes or change saved grants. Switching the character, dataset or workspace clears results and cancels the pending browser request. Results remain in memory, with no history or background polling.

Faction-warfare statistics keep yesterday, last-week and total kills and victory points separate. Enrollment, faction and rank fields appear only when reported; an upstream error is not evidence that a character is unenlisted. This view does not fetch killmails, player identities, fleet activity or location. NPC standings show the entity kind, exact source ID and reported standing; they do not calculate skill effects, mission eligibility, docking access or travel safety. Loyalty balances stay separate for each corporation and are not converted to ISK, combined into net worth or treated as cash.

Reputation charts cover only the currently displayed batch. Standings retain their sign on a fixed −10 to +10 scale, with a separate positive/zero/negative composition chart. Loyalty bars keep each NPC corporation’s balance separate. Faction-warfare kills and victory points use separate charts for yesterday, last week and total; overlapping periods are never added together. Bounded charts identify their displayed subset, and the exact-value tables remain available. These charts make no additional reads or name lookups.

Standings and loyalty lists show at most 100 rows per slice. **Load next batch** deliberately reads the same provider endpoint again and selects the next slice, so a changing feed may overlap or omit records. Coverage and freshness distinguish the displayed slice from the provider response. Missing permissions, failed reads and malformed data do not become zero balances or counts. No names, contacts, member lists or additional private datasets are fetched by these views. The API behavior is reviewed against [CCP's dated ESI schema](https://esi.evetech.net/meta/openapi.json?compatibility_date=2026-10-31); [CCP's standings guide](https://support.eveonline.com/hc/en-us/articles/203217152-Standings) and [loyalty-points guide](https://support.eveonline.com/hc/en-us/articles/14141831188636-Loyalty-Points) describe the broader game mechanics.

## Personal industry

The **Industry** tab offers a personal **Blueprint library**, **Research agents**, **Planetary colonies** and **Mining ledger** for one selected character. It reuses the existing character blueprint, research-agent, planetary and mining read permissions. Loading, refreshing and continuing are explicit; switching the character, view or workspace clears results and cancels pending reads. No new scope or write operation is added.

Blueprints distinguish originals, copies and stacks of fresh originals, and show reported material/time efficiency, remaining copy runs and exact type/item/location IDs. Location IDs are not resolved into stations or containers. Each response page is shown in slices of at most 100 rows; summary counts cover that page, not an entire inventory. Missing page counts remain unknown, and a final page of a larger result is still partial coverage.

Research-agent rows show the reported agent/skill IDs, start time, RP-per-day rate and remainder value. Remainders retain their sign and decimal precision; they are provider inputs, not a computed spendable balance. No elapsed-time accrual, datacore value or profit is estimated. Planetary-colony rows show the listed planet/system IDs, planet type, upgrade level, pin count and last-update time. Selecting this view reveals colony locations from the list response; it does not fetch colony layouts, pins, links, routes, extractor schedules or contents. Pin counts and update times do not establish production health, harvestable goods or profit.

The mining ledger shows reported quantities for each UTC date, inventory type and solar system. Summary counts cover records, distinct types and distinct systems on the fetched page; quantities of different materials are not added together or valued. The dated ESI schema describes a rolling 30-day ledger. A returned page does not establish complete historical coverage, and this app does not save a mining history. Paging uses the same bounded slices and explicit coverage as blueprints.

Research and colony lists also use bounded manual slices, with exact IDs, coverage and freshness. All four views fetch only the selected private dataset. **Show public type and system names** is off by default: selecting it and then loading a view makes one bounded public lookup for type/skill or solar-system IDs derived from the displayed rows. Exact numeric IDs remain visible. Item, container, location, planet, agent and character IDs are never submitted for this enrichment. Failed or incomplete name lookups leave the primary data visible with a separate status. No extra private location query is made. [CCP's blueprint guide](https://support.eveonline.com/hc/en-us/articles/203269951-Blueprints), [datacore guide](https://support.eveonline.com/hc/en-us/articles/203210652-Datacores) and [dated ESI schema](https://esi.evetech.net/meta/openapi.json?compatibility_date=2026-10-31) explain the underlying fields and mechanics.

## Development

For a private runtime that stays in code parity with development, follow [PRIVATE_USE.md](PRIVATE_USE.md). The local folder convention is `OptiEVE-dev` for development and sibling `OptiEVE` for the private runtime; both source sync and catalog refresh use that default target. Use `--target` for another private location. Runtime credentials and account state belong in that separate directory or its private hosting environment, never in the public GitHub repository also named `OptiEVE`.

The runtime is Vinext/React on Cloudflare Workers, with Cloudflare D1 storage and Sites hosting integration. It is not a standalone Next.js server.

Use Node.js **22.13.0 or newer** and **pnpm 11.25.0**. Install the locked dependencies from the project directory:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

The portable development preview normally uses `http://localhost:5173`. Its loopback-only mock sign-in is for local UI development. Running it does not establish an EVE connection or production authentication.

The optional connected-app preview bridge requires HTTP and a fixed port. It supports IPv4/IPv6 loopback and wildcard listeners, keeping bridge requests on loopback. HTTPS and remote-only listener settings fail explicitly during preview configuration; hosted production connections use their separate runtime binding.

Run the source checks and build with:

```sh
pnpm check:public
pnpm test:public
pnpm exec tsc --noEmit
pnpm test:security
pnpm build
pnpm test:runtime
```

The public-source check rejects private data/export files, archives, unreviewed binary content, links and junctions, deployment bindings, personal machine paths and several credential formats. It is a guard against common mistakes; review new content and run a credential scanner as well.

To create a source package for sharing, install Git and run:

```sh
pnpm package:public
```

This writes `outputs/public-release/OptiEVE-public-source.zip` and its SHA256 checksum. It captures the current checked source, including uncommitted edits and deletions, then verifies every ZIP entry against those exact bytes. It does not export older committed content or copy Git history. Git attributes cannot silently remove or rewrite files in this package. The command does not commit changes or create a remote repository.

Share this source ZIP rather than a ZIP of the entire working directory. Local dependencies, package caches, preview mailboxes and generated builds can contain machine paths, runtime data or framework-generated secrets; they are excluded from the package. Ignored files are outside the public-source selection. The independent Git history and actual outgoing ZIP still need credential/privacy review before publishing a repository or release.

The `test:public` regression suite checks the export boundaries with synthetic fixtures in temporary directories. It covers stale Git content, links, private artifacts, environment examples and archive integrity.

The security suite uses generated test credentials, mocked EVE responses and an in-memory SQLite database. It checks encryption, user isolation, OAuth state, JWT validation, refresh rotation, permission handling, protocol validation, request byte limits and connection-page recovery. It includes races between sign-in completion and disconnect. It does not verify a deployed authentication gateway or real EVE permissions.

The runtime regression runs the built worker through the same local Wrangler command as `pnpm start`, using temporary storage and synthetic identities. It checks repeated rejected POST requests followed by healthy API, MCP, HTML, asset and RSC responses. Run it in a temporary installed validation copy; it refuses private runtimes. The API drains unread rejected request bodies without buffering or logging them to avoid the Windows connection failure described in [workers-sdk #15203](https://github.com/cloudflare/workers-sdk/issues/15203).

The `install:ci` script is intended for the managed Linux/Sites environment and depends on shell utilities. Use the commands above for a portable checkout. A production build writes `dist/server/wrangler.json`; building alone does not publish the application.

## Set up a separate deployment

Publishing source does not change a **private hosted deployment's** audience. Keep the deployment restricted to its intended owner, and configure a new environment for each separate installation:

1. Associate the checkout with your own new Sites project through the supported Sites workflow. Ensure `.openai/hosting.json` uses the new project's identity, the `mcp` capability and D1 binding `DB`.
2. Provision a separate D1 database and apply the migrations in `drizzle/` through that workflow.
3. Set `EVE_SITE_ORIGIN` to the exact HTTPS origin of your deployment.
4. Generate a fresh cryptographically random 32-byte key, encode it in standard base64, and store it as the hosted secret `EVE_TOKEN_KEY`. Keep it out of source, build artifacts and logs. Do not reuse another deployment's key or authorization database.
5. Publish using the supported Sites source and build workflow, retaining the private audience and authentication gateway.
6. Register your own EVE developer application. Use the deployment origin as its website and `${EVE_SITE_ORIGIN}/eve/callback` as its callback URL. Add the read scopes shown by the setup page.
7. Enter that application's public Client ID on the private setup page and complete EVE sign-in for each character. Select corporation access only when needed. This implementation does not collect an EVE password or store an EVE client secret.
8. Verify connection status and actual authorized reads through your deployment's plugin.

For an existing installation, preserve its encryption key unless performing a deliberate rotation: replacing it makes saved encrypted authorizations unreadable and requires affected characters to reconnect.

## Authentication and data handling

Production routes trust the `oai-authenticated-user-id` header supplied by the Sites gateway. **Do not expose the worker as a raw public server or put it behind an untrusted proxy.** The authentication gateway must prevent callers from forging trusted identity headers and enforce the deployment's audience. Local mock sign-in does not provide these guarantees.

Tokens and PKCE verifiers are encrypted on the server. Connection metadata, including character names and IDs, is stored separately. Authorized read results are returned to the calling client; treat account data, chat exports and database backups as private.

Disconnect removes the connector's stored authorization and cancels that user's pending sign-ins, so an earlier callback cannot restore the removed connection. Start a fresh sign-in when reconnecting. Revoking the application grant at EVE is a separate action. See [SECURITY.md](SECURITY.md) for deployment and disclosure guidance.

## Data limits

EVE caches API responses and limits historical availability. Follow pagination and wallet transaction cursors before computing totals. Corporation wallet transaction and journal reads cover one selected division at a time; balance reads report the returned divisions with explicit coverage. Public regional market books can omit private structure orders. The application does not provide a long-term transaction archive or recurring polling.

## Third-party notices

Preserve the bundled notices in `vendor/shadcn-tailwind-4.13.0.LICENSE.md` and `scripts/vite/sites-vite-plugin.LICENSE`, along with dependency licenses. This README does not add or change a license grant for the project.
