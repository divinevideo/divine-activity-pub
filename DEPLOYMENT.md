# Production releases

The **Check and release** workflow tests and bundles each pull request and each
push to `main`. Production runs only for a successful checked `main` push or a
manual run selected on `main`. It checks out that run's exact SHA, uses the
lockfile's Wrangler through `npm run deploy`, and tags the provider version with
the full source SHA. Staging remains a separate, manually operated configuration.

## Activation prerequisites

**CD is fail-closed until `PRODUCTION_CD_ENABLED=true` is configured.** A main
release without that confirmation fails visibly; it does not silently skip or
claim a deployment. This change does not configure GitHub or deploy anything.
An authorized Platform operator must first:

1. Confirm the live ingress for `divine.video/ap/*` reaches Worker
   `divine-activity-pub` in the intended Cloudflare account. The router's current
   source sends ActivityPub traffic through Fastly to
   `divine-activity-pub.protestnet.workers.dev`; apex DNS resolves to Fastly.
   The declared Cloudflare zone route alone does not establish the serving path.
   Verify the live router backend and the account owning `protestnet.workers.dev`,
   and retain `workers_dev = true`: that endpoint is load-bearing for this ingress.
   Compare live settings, cron and queue ownership with `wrangler.toml`.
   Resolve drift before enabling; do not create replacements, disable workers.dev,
   or move traffic. Confirm existing
   `AP_DB`, `AP_CACHE`, and `DELIVERY_QUEUE` identifiers match that config. The
   separate staging Worker must not become the production target.
2. Confirm the current runtime secrets and signer configuration remain available.
   Deploy uses `--keep-vars` to retain dashboard variables and existing secrets;
   it does not upload, rotate or print them. Do not pass application secrets
   through GitHub. Deployment does not enable keycast, change queue ownership,
   run migrations, or change signing modes.
3. Create or reuse the GitHub `production` environment and inspect its actual
   protection rules. Restrict deployment branches to `main`, retain existing
   required reviewers and other protections, and decide the approval policy if
   none exists. Merely naming an environment in YAML does **not** enforce approval.
   Require the `checks` job in branch protection as appropriate for the repo.
4. Add environment secrets `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.
   Use a scoped token for the existing account with Workers Scripts Edit (and
   read access to versions/deployments), Workers Routes Edit for the existing
   `divine.video` zone, and the binding lookup permissions Wrangler requires:
   Account Settings Read, D1 Read, Workers KV Storage Read and Queues Read.
   Confirm the minimum permissions against an authorized deployment; do not
   substitute a global API key. GitHub's automatic token needs only Contents Read.
5. Set the production environment variable `PRODUCTION_CD_ENABLED=true` only
   after those checks. Run the workflow on current `main` under the normal
   environment approvals and inspect its result. A controlled production run
   is still required to establish end-to-end acceptance; local tests do not.

No prerequisite resource, environment, protection or credential is provisioned
automatically. A missing prerequisite is an operator action, not permission to
create or replace it. The current production/staging queue arrangement in the
Wrangler files is preserved.

## Ordering and evidence

The production concurrency group never cancels an in-flight activation. Queued
older commits and manual reruns are rejected if their SHA is no longer current
`main`; GitHub may replace a pending run with a newer pending run. All production
writers must use the same group, or coordinate an explicit CD pause for manual
operations. A push arriving after the freshness check waits behind the current
activation, so an older workflow cannot overwrite an already deployed newer run.

`release-result.json`, the workflow artifact, and the job summary record the
environment, full source SHA, run/attempt, previous version, active provider
version, timestamps and result. Wrangler errors, provider read errors, stale
commits and persistent health mismatches fail the job. An upload failure also fails the job.
If setup fails before the release script, the Actions job log records the failure
and no release receipt is claimed.

Success requires a single provider version at 100%, its `workers/tag` matching
the checked SHA, and an uncached GET to `https://divine.video/ap/health` returning
that same version and source. The endpoint performs no database initialization,
upstream calls or federation. It is a routing/version check, not a database or
federation readiness probe. A provider re-read detects activation during the
health check. Verification retries reads up to six times, five seconds apart,
with a ten-second timeout on each HTTP read, to allow edge propagation. It never
repeats the deployment on a failed read. Failed verification may mean the deployment **did** activate;
inspect the receipt and provider before taking recovery action. There is no
automatic rollback or synthetic federation traffic.

## Migrations and rollback

Migrations are deliberately not run by CD. Before shipping code that needs schema
changes, an authorized operator must apply and verify backward-compatible D1
migrations against the confirmed production binding, then release code. Use an
expand/contract sequence; keep previous code compatible until the rollback window
closes. Stop rather than automatically apply destructive changes.

For an incident, coordinate a pause of CD and queued environment approvals first.
Prefer reverting the faulty change on `main` and releasing the new checked commit.
If an immediate provider rollback is authorized, inspect the recorded
`previous_version` and current deployment, then use the local pinned Wrangler:

```sh
npm exec -- wrangler rollback <previous-version-id> --config wrangler.toml
```

This is an operator procedure, not a workflow step or authorization to execute it.
Confirm rollback compatibility with D1 data, KV contents, queues, runtime secrets
and bindings: provider code rollback does not roll back those resources. Verify
the provider's active version and `/ap/health` against the selected version/tag,
record the outcome, and reconcile `main` before re-enabling CD. Older versions
without the metadata health endpoint require explicit operator verification;
they cannot be called verified by this new workflow.
