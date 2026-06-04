# 2. Configure the distroless connection pooler with a Pepr module

Date: 2026-06-04

## Status

Proposed

## Context

The Zalando postgres-operator launches the connection-pooler container with only an image and environment variables — no `command`/`args` — and relies on the image's entrypoint to render `pgbouncer.ini` (and the `userlist.txt` auth file) from those env vars and then exec PgBouncer.

The `unicorn` flavor uses a distroless PgBouncer image (`pgbouncer-fips`) that is the bare binary with no entrypoint script, template, or shell. Launched argument-less it prints usage and exits, so the pooler crash-loops. The operator does not let us set the pooler container's command, volumes, or config, and it reconciles the pooler Deployment, so any manual patch is eventually reverted.

We need a way to supply PgBouncer's config, auth file, and launch command that (a) works with a distroless image, (b) survives operator reconciliation, and (c) is coupled to this package's lifecycle. A one-shot `kubectl`/Job patch was rejected (the operator reverts it on its next write).

## Decision

We ship a [Pepr](https://github.com/defenseunicorns/pepr) module (`src/pepr`, capability `pgbouncer-pooler`), bundled as a manifest in the `unicorn` component, that:

1. reconciles the operator's pooler credential Secret into a derived `pgbouncer-userlist` Secret (the PgBouncer `auth_file`),
2. mutates each pooler Deployment to mount that Secret plus a chart-shipped `pgbouncer-config` ConfigMap at `/etc/pgbouncer` and to set the PgBouncer launch command, and
3. bootstraps pre-existing pooler Deployments on startup so the mutation also applies when the module is installed onto a running cluster.

The static `pgbouncer.ini` is rendered by the `uds-postgres-config` chart. Only the `unicorn` flavor ships the module; `registry1`/`upstream` use self-configuring PgBouncer images and need none of it.

## Consequences

The distroless FIPS pooler now starts and proxies correctly, and because admission mutation re-applies on every operator write there is no reconcile-drift window (`failurePolicy: Ignore` keeps a webhook outage from blocking the operator).

This adds a TypeScript/Node module and a long-lived Pepr controller (admission webhook) to a previously YAML-only package — new build tooling (Node.js, `pepr build`) and an additional component to maintain. The built manifest is committed at `manifests/pepr-module-pgbouncer.yaml`; its shared `pepr-system` Namespace is stripped so package removal does not affect `pepr-uds-core`. The replica pooler is not yet supported (the rendered config targets the primary), and `registry1` would need a similar approach if it ever moves to a distroless pooler image.
