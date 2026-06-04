# pepr-pgbouncer

A [Pepr](https://github.com/defenseunicorns/pepr) module that makes the Zalando postgres-operator's connection pooler work when the pooler image is a **distroless** PgBouncer (the `unicorn` flavor of this package).

## Why this exists

The Zalando operator launches the connection-pooler container with **only an image and environment variables — no `command`/`args`** — and relies on the image's entrypoint to render `/etc/pgbouncer/pgbouncer.ini` (and `userlist.txt`) from those env vars and then exec PgBouncer.

The `unicorn` flavor uses Chainguard's distroless `pgbouncer-fips` image, which is the bare `/usr/bin/pgbouncer` binary — no entrypoint script, no template, no shell. This module adds the missing pieces (config, auth file, and the launch command).

> [!NOTE]
> Currently Only the `unicorn` flavor ships this module.
> The `registry1` flavor needs a similar patch.

## What it does

The module has one capability, `pgbouncer-pooler` (namespace `postgres`), with three handlers in `capabilities/pgbouncer-pooler.ts`:

1. **Reconciler — derive the PgBouncer auth file** (`Watch`/`Reconcile` on the pooler credential `Secret`). When the operator creates `pooler.pg-cluster.credentials.postgresql.acid.zalan.do`, this reads the `username`/`password` and writes a derived Secret **`pgbouncer-userlist`** whose `userlist.txt` key holds the PgBouncer `auth_file` line `"pooler" "<password>"`. The derived Secret is owner-referenced to the source Secret so it is garbage-collected with the cluster. (The distroless image can't transform the raw password into the auth-file format at runtime, so we do it here.)

2. **Mutator — wire up the pooler container** (`Mutate` admission on pooler `Deployment`s, selected by label `application: db-connection-pooler`). Idempotently, on `containers[0]` (the `connection-pooler` container):
   1. mounts a projected volume at `/etc/pgbouncer` combining the **`pgbouncer-config`** ConfigMap's `pgbouncer.ini` (shipped by the `uds-postgres-config` Helm chart) and the **`pgbouncer-userlist`** Secret's `userlist.txt`
   2. sets `command: ["/usr/bin/pgbouncer", "/etc/pgbouncer/pgbouncer.ini"]`.
3. Because admission mutation re-applies on every operator write, the configuration is restored automatically and there is no reconcile-drift window. `failurePolicy` is `Ignore` so a webhook outage can never block the operator from managing the cluster.
4. **Bootstrap — fix pre-existing pooler Deployments** (`Reconcile` on pooler `Deployment`s). A `Mutate` webhook only fires on create/update, so a pooler Deployment that already existed before this module was installed would never be mutated until the operator next wrote it. On module startup the reconciler finds any pooler Deployment **missing** the `pgbouncer` volume (`needsBootstrap`) and touches a pod-template annotation, which triggers an update that the Mutator then enriches. A guard skips Deployments that are already configured, so it runs at most once per Deployment.

## How it fits with the rest of the package

- The static `pgbouncer.ini` lives in the `uds-postgres-config` chart (`chart/templates/pgbouncer-config.yaml`, ConfigMap `pgbouncer-config`, rendered only when `postgresql.poolerConfig.enabled` is true). It uses `auth_type = scram-sha-256` with `auth_query`/`auth_user = pooler`, `server_tls_sslmode = require` for PgBouncer→Postgres, and no client TLS (app→PgBouncer encryption is provided by the Istio service mesh).
- The built module manifest is committed at `manifests/pepr-module-pgbouncer.yaml` and referenced by the `unicorn` component in `zarf.yaml`. The shared `pepr-system` namespace is stripped from that manifest so removing this package never deletes the namespace shared with `pepr-uds-core`.

See `docs/configuration.md` ("Connection Pooler") for the full design, encryption/auth details, tunables, and the known replica-pooler limitation.

## Build & test

```bash
# Build the module manifest into dist/ and copy it to the repo-root manifests/
# (also run automatically during `zarf package create --flavor unicorn`):
uds run build-pepr

# Unit tests:
cd src/pepr && npx vitest run
```

Building requires Node.js 20+ on the host (`uds run build-pepr` uses `uds zarf tools yq` for the namespace strip, and the deployed controller image is pinned in `zarf.yaml` via `--custom-image`; keep that in sync if it changes.
