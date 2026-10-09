# Deploy the FleetWatch Worker on Cloudflare (dashboard + GitHub)

The Worker in [`worker/`](../worker) checks the sites every 5 minutes with a
Cloudflare **Cron Trigger** and serves the public status page. Cloudflare's Git
integration ("Workers Builds") deploys it from this GitHub repository. Nothing
is installed on your PC.

Checked against the Cloudflare docs on **9 October 2026** (pages listed at the end).

## Before you start

- The code must already be on GitHub (`naniiic137/fleetwatch`, branch `main`).
- **Do step 1 and step 2 before step 3.** `worker/wrangler.jsonc` ships with the
  placeholder `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`. A deploy with the placeholder
  fails, so put the real ID in first.
- Everything here fits the **Workers Free plan** (see the KV math in the README).

## 1. Create the KV namespace

1. In the Cloudflare dashboard, open the **Workers KV** page (if it is not in
   the left menu, type "KV" in the dashboard search).
2. Select **Create instance**.
3. Name it `fleetwatch` and select **Create**.
4. Copy the namespace **ID** (a 32-character hex string) from the list.

## 2. Put the ID in `wrangler.jsonc` (recommended)

1. On GitHub, open `worker/wrangler.jsonc` and click the pencil (Edit).
2. Replace `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` with the ID you copied:
   ```jsonc
   "kv_namespaces": [
     { "binding": "FW_KV", "id": "<your 32-character id>" }
   ]
   ```
3. **Commit changes** to `main`. The ID is not a secret; it only works inside your account.

> **Why not only bind it in the dashboard?** You *can* add it under the Worker's
> **Bindings** tab (*Add binding* > *KV namespace*, variable name `FW_KV`).
> Cloudflare recommends treating the Wrangler config file as the source of truth,
> and Wrangler overrides dashboard changes on the next deploy. Every push redeploys
> through `npx wrangler deploy`, so a binding that exists only in the dashboard
> could disappear. Keeping the ID in `wrangler.jsonc` avoids that.
>
> **Why not let Wrangler create the namespace automatically?** Wrangler can
> auto-provision KV when the `id` is left out. The docs say that for deploys
> started from the dashboard/GitHub, "these resource IDs will not be written
> back to your repository", so the repo would still not know the ID.

## 3. Connect the repository

1. Open **Workers & Pages** and select **Create application**.
2. Next to **Import a repository**, select **Get started**.
3. Under **Import a repository**, pick your **GitHub account**. The first time,
   select **+ Add account** > **Install & Authorize** for the "Cloudflare Workers
   and Pages" GitHub app. Choosing **Only select repositories** > `fleetwatch` is enough.
4. Select the repository **`fleetwatch`**.

## 4. Configure the project, then deploy

| Setting | Value |
| --- | --- |
| Worker / project name | `fleetwatch` (**must** match `"name"` in `wrangler.jsonc`, or the build fails) |
| Build command | *(leave empty)* |
| Deploy command | `npx wrangler deploy` (the default) |
| Root directory / Path | `worker` (may be under *Advanced settings*; it is where `wrangler.jsonc` lives) |
| Production branch | `main` |
| Build variables | none needed |

Select **Save and Deploy**. When the build finishes, open the Worker's
`https://fleetwatch.<your-subdomain>.workers.dev` URL.

If you need to change these settings later: the Worker > **Settings** > **Build**.

## 5. Check that it works

- The page first says **"Waiting for the first check"**. The cron runs at every
  5th minute (UTC), so data appears within 5 minutes. Refresh after that.
- `/api/status` returns JSON and `/metrics` returns Prometheus text.
- Cron runs: the Worker > **Settings** > **Trigger Events** shows `*/5 * * * *`;
  **View events** lists the 100 most recent runs. It can take up to 30 minutes
  before the first events show for a new Worker.
- Logs: each run logs one JSON line (`fleetwatch cron run`) with the up/down counts.

## 6. After it is live

Send me the `workers.dev` URL and I will put it in the README's "Live status
page" line and in the repo's About > Website field.

## Free-plan limits this design respects

| Limit (Workers Free) | Value | FleetWatch use |
| --- | --- | --- |
| KV writes | 1,000 / day | 288 / day (one key per 5-minute run) |
| KV reads | 100,000 / day | 288 by the cron + 1 per page view |
| KV value size | 25 MiB | ~85 KB (10 sites, 7 days) |
| CPU time per invocation | 10 ms | status codes only, bodies are not read |
| Subrequests per invocation | 50 | 10 fetches + 2 KV calls per run |
| Cron Triggers per account | 5 | 1 |

## Cloudflare doc pages used

- Workers Builds overview (import a repository; Worker name must match): https://developers.cloudflare.com/workers/ci-cd/builds/
- Build configuration (deploy command `npx wrangler deploy`, root directory, Settings > Build): https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
- Monorepos / root directory: https://developers.cloudflare.com/workers/ci-cd/builds/advanced-setups/
- GitHub integration (Install & Authorize, Only select repositories): https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/
- KV get started (Workers KV > Create instance; Bindings tab > Add binding): https://developers.cloudflare.com/kv/get-started/
- KV bindings (`kv_namespaces` with `binding` + `id`): https://developers.cloudflare.com/kv/concepts/kv-bindings/
- KV limits and pricing (1,000 writes/day, 100,000 reads/day, 25 MiB values): https://developers.cloudflare.com/kv/platform/limits/ and https://developers.cloudflare.com/kv/platform/pricing/
- Wrangler configuration (config file as source of truth, automatic provisioning, `triggers.crons`): https://developers.cloudflare.com/workers/wrangler/configuration/
- Cron Triggers (UTC, `scheduled()` handler, Trigger Events): https://developers.cloudflare.com/workers/configuration/cron-triggers/
- Workers limits (10 ms CPU, 50 subrequests, 5 Cron Triggers on Free): https://developers.cloudflare.com/workers/platform/limits/
