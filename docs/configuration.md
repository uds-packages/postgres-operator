# Configuration

Postgres Operator is configured through the upstream [Zalando Postgres Operator chart](https://github.com/zalando/postgres-operator/tree/master/charts/postgres-operator) as well as a UDS configuration chart. It implements a database for many [applications within a UDS Bundle](https://docs.defenseunicorns.com/core/concepts/configuration--packaging/bundles/) when one is not available in your cloud provider.

## Networking

Network policies are controlled via the `uds-postgres-config` chart and follow [similar networking patterns as the Reference Package](https://github.com/uds-packages/reference-package/blob/main/docs/networking-patterns.md). Because Postgres does not interact with external resources like object storage it only implements `custom` networking for the `postgres-operator` namespace:

- `additionalNetworkAllow`: sets custom network policies for the `postgres-operator` namespace (as a break glass in case you deploy your own postgres cluster custom resources - see below)

## Postgres Clusters

Postgres Operator is configured through [`acid.zalan.do/v1` `Postgresql` custom resources](https://github.com/zalando/postgres-operator/blob/master/docs/reference/cluster_manifest.md#cluster-manifest-reference).  The `uds-postgres-config` chart creates one of these by default which is configurable through the following:

- `postgresql.enabled`: whether to create the default `Postgresql` custom resource (if disabled you will need to apply your own CRs to the cluster)
- `postgresql.teamId`: the name of the team the cluster belongs to (i.e. `uds`)
- `postgresql.volume.size`: the size of the database on disk (i.e. `1Gi`)
- `postgresql.numberOfInstances`: The number of cluster Pods to run in the cluster (i.e. `2`)
- `postgresql.users`: The users to create for the database in the form `{namespace}.{username}` (i.e. `gitlab.gitlab: []`)
- `postgresql.databases`: The database names to create and the users they map to (i.e. `gitlabdb: gitlab.gitlab`)
- `postgresql.extensions`: A map of database names to lists of extensions to enable for that database (i.e. `mydb: ["postgis", "hstore"]`)
- `postgresql.version`: The version of Postgres to run (i.e. `14`)
- `postgresql.ingress`: A list of ingress entries to create for this cluster (follows the [custom networking definition](https://github.com/uds-packages/reference-package/blob/main/docs/networking-patterns.md) except for `direction` which is always `Ingress` and `selector` which is always `cluster-name: pg-cluster`)
- `postgresql.resources`: A Kubernetes Pod resource specification to define requests and limits
- `postgresql.additionalVolumes`: A list of additional volumes to map into the Postgres container if needed (see below)
- `postgresql.tls`: TLS configuration for the Postgres cluster to use (follows the [`tls` section of the Zalando Postgres CR](https://github.com/zalando/postgres-operator/blob/master/docs/reference/cluster_manifest.md#custom-tls-certificates))
- `postgresql.parameters`: A list of database parameters to set as name/value pairs, if needed. `password_encryption` parameter defaults to `scram-sha-256` and cannot be overridden.

```yaml
  parameters:
    - name: max_slot_wal_keep_size
      value: 1GB
    - name: <name>
      value: <value>
```

## Connection Pooler (Unicorn Flavor)

The Zalando operator can front a cluster with a [PgBouncer connection pooler](https://github.com/zalando/postgres-operator/blob/master/docs/reference/cluster_manifest.md#connection-pooler). On the `registry1` and `upstream` flavors the pooler uses Zalando-derived images that build their own `pgbouncer.ini` at startup, so no extra configuration is required. The `unicorn` flavor instead uses Chainguard's distroless `pgbouncer` image, which has no entrypoint to self-configure and therefore crash-loops on its own. To make it work, the unicorn flavor bundles a Pepr module plus a static `pgbouncer.ini` `ConfigMap` (`pgbouncer-config`) that configure the pooler externally. This behavior applies to the unicorn flavor only.

When `postgresql.poolerConfig.enabled` is `true` (the default in the unicorn flavor's values), the chart renders the `pgbouncer.ini` `ConfigMap` and the bundled Pepr module:
- reconciles the operator-created pooler credential secret into a derived `pgbouncer-userlist` secret (a `userlist.txt` auth file in the form `"pooler" "<password>"`), and
- mutates each pooler `Deployment` (`pg-cluster-pooler`, `pg-cluster-pooler-repl`) to mount `pgbouncer.ini` and the auth file at `/etc/pgbouncer` and set the PgBouncer launch command.

Encryption and authentication for the FIPS pooler:
- **App → PgBouncer**: there is no client-side TLS on PgBouncer; in-transit encryption between applications and the pooler is provided by the Istio service mesh (mTLS).
- **PgBouncer → Postgres**: enforced TLS via `server_tls_sslmode = require` (non-SSL connections are rejected by `pg_hba`).
- **Authentication**: `scram-sha-256` with an `auth_query` (`SELECT * FROM pooler.user_lookup($1)`) executed as the `pooler` user.

Pool sizing is configured statically through `postgresql.poolerConfig.*` chart values (rather than the operator's dynamic sizing):

- `postgresql.poolerConfig.enabled`: whether to render the FIPS pooler `ConfigMap` and enable the Pepr-driven configuration (default `false`; set `true` on the unicorn flavor)
- `postgresql.poolerConfig.listenPort`: the port PgBouncer listens on (default `5432`)
- `postgresql.poolerConfig.poolMode`: the PgBouncer pool mode (default `transaction`)
- `postgresql.poolerConfig.defaultPoolSize`: server connections per user/database pair (default `20`)
- `postgresql.poolerConfig.reservePoolSize`: extra connections allowed when a pool is exhausted (default `10`)
- `postgresql.poolerConfig.maxClientConn`: maximum client connections accepted by PgBouncer (default `10000`)
- `postgresql.poolerConfig.maxDBConnections`: maximum server connections per database (default `60`)

> **Limitation — replica pooler:** the rendered `pgbouncer.ini` targets the primary service (`pg-cluster.postgres.svc`). Only the primary pooler (`enableConnectionPooler`) is supported on the FIPS flavor. Do not enable `enableReplicaConnectionPooler` here: the same config would be applied to `pg-cluster-pooler-repl`, routing replica-pooler traffic to the primary. Role-aware (primary/replica) configuration is a follow-up.

### Building and deploying the Pepr module

The Pepr module lives in `src/pepr/` and is built into a Kubernetes manifest at `src/pepr/dist/pepr-module-pgbouncer.yaml`. That `dist/` directory is git-ignored, so the manifest is generated at build time rather than committed.

**It is built and deployed automatically as part of the package — no separate step is required.** The unicorn component in `zarf.yaml` has an `onCreate.before` action that runs `pepr build` whenever the unicorn package is created (`zarf package create --flavor unicorn`, `uds run create-dev-package`, or the release/test CI which call these tasks). The generated manifest is then included as a component `manifests:` entry, and the Pepr controller image (`ghcr.io/defenseunicorns/pepr/private/controller`) is pulled into the package like any other image. Deploying the unicorn package (or a bundle containing it) therefore deploys the module into the `pepr-system` namespace alongside `pepr-uds-core`; there is nothing extra to deploy.

> **Build prerequisite:** the build host (your machine or the CI runner) needs **Node.js 20+** and network access to install dependencies (`npm ci`). This applies only to *creating* the unicorn package, not to *deploying* it in an air-gapped environment — the rendered manifest and the controller image are baked into the package at create time.

For local iteration on the module without creating a full package, run the build directly:

```bash
uds run build-pepr
# equivalent to:
#   cd src/pepr && npm ci && npx pepr build --custom-image ghcr.io/defenseunicorns/pepr/private/controller:v1.2.1
```

Unit tests for the module:

```bash
cd src/pepr && npx vitest run
```

> Keep the `--custom-image` tag in the `zarf.yaml` `onCreate` action, the `build-pepr` task, and the component `images:` list in sync (all reference the same Pepr controller image).

### Lifecycle (install and removal)

The Pepr module is bundled inside the postgres-operator package (a `manifests:` entry on the unicorn component), so its lifecycle is coupled to the package:

- **Install:** deploying the unicorn package deploys the module into the existing `pepr-system` namespace (alongside `pepr-uds-core`), as its own Zarf-managed release.
- **Removal:** `uds`/`zarf package remove` of postgres-operator uninstalls the module release, deleting all of its resources — the Deployments/Services/Secrets/RBAC in `pepr-system` **and** the cluster-scoped `pepr-pgbouncer` `ClusterRole`, `ClusterRoleBinding`, and `MutatingWebhookConfiguration`. Nothing dangling is left behind.

The module's manifest deliberately does **not** include the `pepr-system` `Namespace` object (the build strips it via `yq`). That namespace is created and owned by uds-core and shared with `pepr-uds-core`; excluding it ensures removing this package never cascade-deletes the shared namespace (which would tear down uds-core's Pepr). Consequently the package depends on uds-core having already created `pepr-system` at deploy time, which is always the case in a UDS cluster.

Runtime-created resources are cleaned up too: the derived `pgbouncer-userlist` secret carries an `ownerReference` to the operator's pooler credential secret (garbage-collected when the cluster/secret is removed), and the pooler Deployment mutation disappears with the operator-managed pooler Deployment when the cluster is torn down.

### Verifying the pooler (unicorn)

```bash
# pooler pods should be Running (not CrashLoopBackOff / usage-exit)
kubectl -n postgres rollout status deployment/pg-cluster-pooler --timeout=180s
# the pepr module should have created the derived auth secret
kubectl -n postgres get secret pgbouncer-userlist
# the pooler Deployment should carry the injected command + /etc/pgbouncer mount
kubectl -n postgres get deploy pg-cluster-pooler -o jsonpath='{.spec.template.spec.containers[0].command}'; echo
# end-to-end: connect through the pooler service and run a query (use your app/pooler user)
# kubectl -n postgres run pooler-check --rm -it --image=<psql-image> --restart=Never -- \
#   psql "host=pg-cluster-pooler.postgres.svc port=5432 dbname=<db> user=<user>" -c 'select 1;'
```

## Secrets Creation

The operator creates credentials secrets in the namespace defined by the `{namespace}.{username}` prefix in `postgresql.users`. See the [Reference Package configuration](https://github.com/uds-packages/reference-package/blob/main/docs/configuration.md#secrets-creation) for an example of how to consume these secrets within an application chart.

## Postgres HugePages

Postgres Operator can also support HugePages by setting the following keys appropriately for your environment.  You can learn more about HugePages in Kubernetes in their [Manage HugePages documentation](https://kubernetes.io/docs/tasks/manage-hugepages/scheduling-hugepages/#api) and learn more about these fields in the [`Postgresql` custom resource reference documentation](https://github.com/zalando/postgres-operator/blob/master/docs/reference/cluster_manifest.md#cluster-manifest-reference).

- `postgresql.resources`: This allows you to set the desired hugepages `limits` and `requests`
- `postgresql.additionalVolumes`: This allows you to map the correct hugepages volumes into the container, e.g.:

```yaml
  - name: hugepage-2mi
    mountPath: /hugepages-2Mi
    volumeSource:
      emptyDir:
        medium: HugePages-2Mi
```

## Postgres Extensions

Postgres Operator supports enabling PostgreSQL extensions for specific databases using the `postgresql.extensions` configuration. Extensions are enabled via a Kubernetes Job that runs after the database cluster is created.

- `postgresql.extensions`: A map of database names to arrays of extension names to enable

Example:

```yaml
postgresql:
  extensions:
    mydb: ["postgis", "hstore", "pg_trgm"]
    anotherdb: ["uuid-ossp", "pgcrypto"]
```

The Spilo PostgreSQL image includes 100+ extensions. You can view the complete list by running:

```bash
docker run --rm ghcr.io/zalando/spilo-17:4.0-p2 bash -c "ls -1 /usr/share/postgresql/17/extension/*.control | xargs -n1 basename | sed 's/.control$//' | sort"
```

> [!NOTE]
> You may need to swap the above image to match the package flavor you are using.

Commonly used extensions include:
- **Spatial/GIS**: `postgis`, `address_standardizer`, `earthdistance`
- **Data Types**: `hstore`, `citext`, `uuid-ossp`, `vector`, `ltree`
- **Full Text Search**: `pg_trgm`, `fuzzystrmatch`, `unaccent`
- **Crypto**: `pgcrypto`
- **Time Series**: `timescaledb`
- **Monitoring**: `pg_stat_statements`
