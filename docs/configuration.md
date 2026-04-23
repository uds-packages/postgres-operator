# Configuration

Postgres Operator is configured through the upstream [Zalando Postgres Operator chart](https://github.com/zalando/postgres-operator/tree/master/charts/postgres-operator) as well as a UDS configuration chart. It implements a database for many [applications within UDS Software Factory](https://github.com/defenseunicorns/uds-software-factory/blob/main/docs/database.md#uds-postgres-operator-package) when one is not available in your cloud provider.

## Networking

Network policies are controlled via the `uds-postgres-config` chart in accordance with the [common patterns for networking within UDS Software Factory](https://github.com/defenseunicorns/uds-software-factory/blob/main/docs/networking.md).  Because Postgres does not interact with external resources like object storage it only implements `custom` networking for the `postgres-operator` namespace:

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
- `postgresql.ingress`: A list of ingress entries to create for this cluster (follows the [custom networking definition](https://github.com/defenseunicorns/uds-software-factory/blob/main/docs/networking.md) except for `direction` which is always `Ingress` and `selector` which is always `cluster-name: pg-cluster`)
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
