# Configuration

Postgres Operator is configured through the upstream [Zalando Postgres Operator chart](https://github.com/zalando/postgres-operator/tree/master/charts/postgres-operator) as well as a UDS configuration chart. It implements a database for many [applications within a UDS Bundle](https://docs.defenseunicorns.com/core/concepts/configuration--packaging/bundles/) when one is not available in your cloud provider.

## Networking

Network policies are controlled via the `uds-postgres-config` chart and follow [similar networking patterns as the Reference Package](https://github.com/uds-packages/reference-package/blob/main/chart/templates/uds-package.yaml). Because Postgres does not interact with external resources like object storage it only implements `custom` networking for the `postgres-operator` namespace:

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
- `postgresql.ingress`: A list of ingress entries to create for this cluster (follows the [custom networking definition](https://github.com/uds-packages/reference-package/blob/main/chart/templates/uds-package.yaml) except for `direction` which is always `Ingress` and `selector` which is always `cluster-name: pg-cluster`)
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

## Secrets Creation

The operator creates credentials secrets in the namespace defined by the `{namespace}.{username}` prefix in `postgresql.users`. See the [Reference Package configuration](https://github.com/uds-packages/reference-package/blob/main/docs/configuration.md#secrets-creation) for an example of how to consume these secrets within an application chart.

## Connection Pooling

Postgres Operator can deploy [pgbouncer](https://www.pgbouncer.org/) alongside the cluster to pool client connections, reducing backend churn for high-connection-count workloads. Poolers are deployed as separate `Deployment`s (`<cluster>-pooler` and/or `<cluster>-pooler-repl`) and exposed via matching `Service`s on port `5432`. Required network policies for the pooler pods are generated automatically when either flag below is enabled.

- `postgresql.enableConnectionPooler`: deploy a pgbouncer pooler in front of the primary (RW traffic)
- `postgresql.enableReplicaConnectionPooler`: deploy a pgbouncer pooler in front of the replicas (RO traffic)
- `postgresql.connectionPooler`: optional map of pooler settings passed through to the `Postgresql` CR (e.g. `numberOfInstances`, `mode`, `resources`)

Example:

```yaml
postgresql:
  enableConnectionPooler: true
  enableReplicaConnectionPooler: true
  connectionPooler:
    numberOfInstances: 2
    mode: transaction
```

Clients connect through the pooler by pointing at `<cluster>-pooler.<namespace>.svc.cluster.local` (primary) or `<cluster>-pooler-repl.<namespace>.svc.cluster.local` (replicas) instead of the cluster Service.

### Registry1 pooler shim

The `registry1` flavor consumes the Iron Bank pgbouncer image, which diverges from upstream Zalando in two ways the operator does not expose via configuration:

1. The `pgbouncer` user is built as UID `997`, but the Zalando operator hardcodes the pooler pod to `runAsUser: 100`. As a result the entrypoint cannot write the self-signed TLS cert to `/etc/pgbouncer/`, the log to `/var/log/pgbouncer/`, or the pidfile to `/var/run/pgbouncer/`.
2. The baked-in `pgbouncer.ini.tmpl` hardcodes `auth_type = plain`, which fails against postgres's default `scram-sha-256` encryption (pgbouncer cannot replay SCRAM secrets returned by `auth_query` when operating in plain mode).

To keep the pooler usable without rebuilding the image or adding a Pepr mutation, the `registry1` component in `zarf.yaml` runs [`tasks/registry1-pooler-patch.yaml`](../tasks/registry1-pooler-patch.yaml) as an `onDeploy.after` action. For each operator-managed pooler Deployment it strategic-merge patches in:

- three in-memory `emptyDir` volumes mounted at `/etc/pgbouncer`, `/var/log/pgbouncer`, and `/var/run/pgbouncer` (writable under the pod's `fsGroup: 103`)
- a `seed-pgbouncer-etc` init container that copies Zalando's `.tmpl` files into the emptyDir and rewrites `auth_type = plain` to `auth_type = scram-sha-256` before the main container renders them via `envsubst`

The operator's pooler sync does not compare `volumes`, `volumeMounts`, or `initContainers`, so the patch survives its reconcile loop. The `upstream` flavor ships the Zalando-curated pgbouncer image and does not need the shim.

### Unicorn pooler shim

The `unicorn` flavor consumes `cgr.dev/defenseunicorns.com/pgbouncer`, which is a generic upstream Chainguard pgbouncer image rather than a Zalando rebuild. Two consequences the operator does not expose via configuration:

1. The image's `ENTRYPOINT` is `/usr/bin/pgbouncer` with `CMD` `["--help"]` and ships no `/etc/pgbouncer/*.tmpl` files or entrypoint script. The Zalando operator leaves the pooler container's `command`/`args` unset and depends on the image entrypoint to render config from `PGHOST`/`PGPORT`/`PGUSER`/`CONNECTION_POOLER_*` env vars and exec pgbouncer; with this image the pod just runs `pgbouncer --help` and exits.
2. The image is fully minimal (only the `pgbouncer` binary — no `sh`, `openssl`, or `envsubst`), so the rendering cannot be done inside the main container.

To keep the pooler usable without rebuilding the image or adding a Pepr mutation, the `unicorn` component in `zarf.yaml` runs [`tasks/unicorn-pooler-patch.yaml`](../tasks/unicorn-pooler-patch.yaml) as an `onDeploy.after` action. For each operator-managed pooler Deployment it strategic-merge patches in:

- three in-memory `emptyDir` volumes mounted at `/etc/pgbouncer`, `/var/log/pgbouncer`, and `/var/run/pgbouncer` (writable under the pod's `fsGroup: 103`)
- a `seed-pgbouncer-etc` init container that reuses the unicorn flavor's spilo image (already pulled for the postgres pods, has `sh` + `openssl`) to render `pgbouncer.ini`, `auth_file.txt`, and a self-signed TLS cert into the emptyDir — replicating upstream Zalando's `entrypoint.sh`, with `auth_type = scram-sha-256` (PG17 default) and without the Zalando downstream-fork-only `stats_users_prefix` directive that vanilla pgbouncer rejects
- the operator-set env block replicated onto the init container (extracted live via `kubectl jsonpath`) so the rendered config matches the configured `pool_mode`/sizes/ports; `PGUSER` and `PGPASSWORD` are preserved as `secretKeyRef`s so the password never lands in plaintext in the Deployment spec
- a `command` override on the main container to `["/usr/bin/pgbouncer", "/etc/pgbouncer/pgbouncer.ini"]`

References:

- [Zalando — Connection pooler](https://opensource.zalando.com/postgres-operator/docs/user.html#connection-pooler)
- [OneUptime — PostgreSQL with the Zalando operator](https://oneuptime.com/blog/post/2026-01-21-postgresql-zalando-operator/view)

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
