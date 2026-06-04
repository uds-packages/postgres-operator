# Design: FIPS Connection Pooler via Pepr Module

- **Date:** 2026-06-03
- **Status:** Approved (design); pending implementation plan
- **Scope:** `unicorn` flavor only

## Problem

On the `unicorn` flavor, `connection_pooler_image` is set to Chainguard's
**distroless** `cgr.dev/defenseunicorns.com/pgbouncer-fips`. The Zalando
postgres-operator launches the pooler container with **only an image + env vars
and no `command`/`args`** (confirmed in `pkg/cluster/connection_pooler.go`,
v1.15.1). It depends on the image's ENTRYPOINT to render
`/etc/pgbouncer/pgbouncer.ini` (+ `userlist.txt`) from those env vars via
`envsubst` and then `exec pgbouncer <config>`.

The canonical Zalando image (`registry.opensource.zalan.do/acid/pgbouncer`) and
the Iron Bank rebuild (`registry1.dso.mil/.../zalando/pgbouncer`) carry that
entrypoint script + template. Chainguard's distroless image is the bare
`/usr/bin/pgbouncer` binary — no entrypoint script, no template, no shell — so
the operator's argument-less launch yields `pgbouncer` with no `CONFIG_FILE`,
which prints usage and exits.

This is an **image-compatibility** problem, not a chart/values bug.

## Why not the simpler options

- **One-shot Job/Zarf patch (rejected).** The operator's
  `syncConnectionPoolerWorker` regenerates the entire pod spec and `Update()`s
  the Deployment whenever a *tracked* field drifts (image, resources, replicas,
  `PGUSER`/`PGSCHEMA`, owner refs). It does not track
  `command`/`initContainers`/`volumes`, so a patch survives steady-state 5-min
  resyncs but is **silently wiped** on the next operator-driven update (image
  bump, CR edit, operator restart perceiving drift). Latent breakage; also races
  the operator on first create. Wrong for a shipped feature.
- **Swap to an operator-compatible FIPS image (rejected).** Would be cleanest if
  such an image existed, but it requires the Zalando entrypoint glue that the
  distroless FIPS image deliberately omits. The requirement is to use the
  distroless Chainguard FIPS image.

## Chosen approach

A standalone **Pepr module**, deployed only for the `unicorn` flavor, that:

1. **Mutates** the operator-created pooler Deployment on every create/update to
   mount a config ConfigMap + a derived auth Secret and set the pgbouncer
   `command`. Because admission mutation re-applies on every operator write,
   there is no drift window.
2. **Reconciles** the operator's pooler credential Secret into a derived
   `userlist.txt` Secret (the distroless image cannot transform the raw password
   into pgbouncer's `auth_file` format at runtime).

No new images beyond the Pepr controller, which **reuses the FIPS Pepr image
uds-core already runs** (prerequisite — see Risks).

## Key environment facts (verified)

- Cluster uses **`scram-sha-256`** (`chart/templates/postgres-minimal.yaml`:
  `password_encryption: scram-sha-256`, pg_hba). The rendered config MUST use
  `auth_type = scram-sha-256` (not the upstream template's `md5`).
- pg_hba contains `hostnossl all all all reject` → **pgbouncer→postgres must use
  SSL** (`server_tls_sslmode = require`; `require` encrypts without needing a CA).
- Pooler container is `containers[0]`, name **`connection-pooler`**
  (`k8sres.go`), runs as uid 100 / gid 101.
- Pooler Deployments: `pg-cluster-pooler` (primary), `pg-cluster-pooler-repl`
  (replica); pods labeled `application: db-connection-pooler`.
- Pooler user/schema default **`pooler`/`pooler`**; credential Secret
  `pooler.pg-cluster.credentials.postgresql.acid.zalan.do` (keys `username`,
  `password`).
- Operator sets on `containers[0]`: `PGHOST`, `PGPORT`, `PGUSER`, `PGSCHEMA`,
  `PGPASSWORD`, `CONNECTION_POOLER_{PORT,MODE,DEFAULT_SIZE,MIN_SIZE,RESERVE_SIZE,MAX_CLIENT_CONN,MAX_DB_CONN}`.
- Operator installs the `pooler.user_lookup` SECURITY DEFINER function in each
  database regardless of pooler image, so `auth_query` works.

## Decisions

| Topic | Decision |
|---|---|
| Module scope | Deployed for `unicorn` flavor only; mutates **all** pooler Deployments unconditionally (no runtime image gate). |
| Client TLS (app→pgbouncer) | Disabled in pgbouncer; rely on Istio mesh mTLS for encryption-in-transit. |
| Server TLS (pgbouncer→postgres) | `server_tls_sslmode = require` (mandatory; non-SSL rejected by pg_hba). |
| `userlist.txt` | Pepr-derived Secret; no init container, no extra image. |
| `failurePolicy` | `Ignore` (a webhook outage must not block the operator). |
| Static `pgbouncer.ini` | Shipped by the Helm chart (gated by a unicorn-only values flag). |

## Architecture & components

New Pepr module in `src/pepr/`, built with `pepr build`, deployed as a
flavor-gated Zarf component (`only.flavor: unicorn`). One capability,
`pgbouncer-fips-pooler`, with two parts:

- **Reconciler** — `When(a.Secret).IsCreatedOrUpdated().InNamespace("postgres")`
  filtered to `pooler.pg-cluster.credentials.postgresql.acid.zalan.do`. Writes a
  derived Secret `pgbouncer-fips-userlist` with key `userlist.txt` =
  `"pooler" "<password>"`, owner-referenced to the source Secret for GC.
- **Mutator** —
  `When(a.Deployment).IsCreatedOrUpdated().InNamespace("postgres")` filtered to
  `application: db-connection-pooler` (covers `-pooler` and `-pooler-repl`).
  Idempotently mounts the `pgbouncer-config` ConfigMap and the
  `pgbouncer-fips-userlist` Secret into `containers[0]`, and sets
  `command: ["/usr/bin/pgbouncer", "/etc/pgbouncer/pgbouncer.ini"]`.

The static `pgbouncer.ini` ConfigMap (`pgbouncer-config`) is rendered by
the Helm chart from chart values: `pool_mode`, pool sizes, `auth_type =
scram-sha-256`, `auth_query = SELECT * FROM pooler.user_lookup($1)`,
`auth_user = pooler`, `auth_file = /etc/pgbouncer/userlist.txt`,
`server_tls_sslmode = require`, client TLS disabled, plus
`ignore_startup_parameters = extra_float_digits,options`.

## Data flow & ordering

1. Operator creates the pooler Secret → Reconciler writes
   `pgbouncer-fips-userlist`.
2. Operator creates/updates the pooler Deployment → Mutator injects
   volumes/mounts + command. Mutation references ConfigMap/Secret **by name**
   only (does not read contents), so it succeeds regardless of ordering.
3. If the pod starts before the derived Secret exists, the kubelet holds it in
   `ContainerCreating` until the Secret volume resolves — no crash-loop.
4. Every later operator reconcile re-triggers the Mutator → injected fields are
   restored; drift is impossible.
5. Password rotation: operator updates source Secret → Reconciler rewrites
   derived Secret. Baseline is pod restart to pick up; live `RELOAD` is a
   possible follow-up.

Idempotency: the Mutator checks for its own volume/mount/command before adding,
so repeated mutations are no-ops and there is no operator↔webhook hot-loop.

## Error handling & edge cases

- Derived Secret missing/slow → kubelet volume-wait; self-heals on next Secret
  event (Reconciler is idempotent, single writer).
- Reconciler can't read source Secret (RBAC/timing) → logged + retried; nothing
  acts on stale data (Mutator references by name).
- Replica pooler → same labels, covered automatically; one derived
  Secret/ConfigMap serves both.
- Missing `user_lookup` → pgbouncer auth fails clearly in its log (surfaced).
- Wrong flavor/image → module not shipped outside unicorn, so it can't touch
  Zalando-image poolers.
- Webhook down → `failurePolicy: Ignore`; a pooler created during the outage
  runs unconfigured until the next operator write re-triggers the recovered
  mutation.

## Testing

- **Pepr unit tests** — Mutator produces expected volumes/mounts/command and is
  a no-op when already mutated; Reconciler renders correct `userlist.txt` from a
  fake source Secret. No cluster required.
- **e2e (unicorn)** — extend existing `tests/postgres/` pooler tests: deploy
  unicorn flavor with `enableConnectionPooler: true`, assert pooler pods reach
  `Running` (not usage-exit), then run the existing through-pooler psql
  connectivity check. Regression guard for the original bug.
- **Ordering** — cold-deploy e2e implicitly covers pod-before-Secret via the
  kubelet volume-wait path.
- **Flavor gating** — assert the Pepr component is absent from `registry1` /
  `upstream` builds.
- CI: module builds in the existing pipeline; `pepr build` output (image +
  manifests) wired into `zarf.yaml`; matches current lint/test/scan workflows.

## Packaging & repo layout

- `src/pepr/` (new): `package.json`, `pepr.ts`,
  `capabilities/pgbouncer-fips-pooler.ts`.
- Pepr controller image: reuse uds-core's FIPS image (prerequisite to confirm).
- `zarf.yaml`: Pepr component gated `only.flavor: unicorn`, plus its image entry.
- `chart/`: add `pgbouncer.ini` ConfigMap template gated by a unicorn-only
  values flag (e.g. `postgresql.poolerFipsConfig: true` in
  `values/unicorn-values.yaml`); never rendered for other flavors.
- `docs/configuration.md`: document FIPS-flavor pooler behavior (mesh mTLS,
  scram-sha-256).
- `renovate.json` / scan / lint: wire the new image + TS module into automation.
- Names: derived Secret `pgbouncer-fips-userlist`, ConfigMap
  `pgbouncer-config`, capability `pgbouncer-fips-pooler`, namespace
  `postgres`.

## Risks / prerequisites

1. **FIPS Pepr controller image** must be available (reuse uds-core's). If not,
   the lift and image-sourcing change — confirm before implementation.
2. Adds a TypeScript/Node toolchain to a currently pure YAML/Helm/Zarf repo — a
   real maintenance consideration; mirrors uds-core's structure and is the
   standard UDS way to ship admission logic.
3. Password duplicated into a second in-namespace Secret (`pgbouncer-fips-userlist`),
   RBAC-protected like the source.

## Reference

Upstream `pooler/pgbouncer.ini.tmpl` and `pooler/entrypoint.sh`
(zalando/postgres-operator) are the source of truth for the rendered config;
this design reproduces them with `auth_type = scram-sha-256` and client TLS
disabled (mesh mTLS), and replaces the `envsubst`/`exec` entrypoint with a
chart-rendered ConfigMap + Pepr mutation.
