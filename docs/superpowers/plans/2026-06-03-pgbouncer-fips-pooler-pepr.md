# FIPS Connection Pooler via Pepr Module — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Zalando connection pooler work on the `unicorn` flavor's distroless `pgbouncer-fips` image by shipping a Pepr module that supplies pgbouncer's config + auth and sets its launch command.

**Architecture:** The Helm chart ships a static `pgbouncer.ini` ConfigMap (unicorn-gated). A flavor-gated Pepr module (1) reconciles the operator's pooler credential Secret into a derived `userlist.txt` Secret, and (2) mutates each operator-created pooler Deployment to mount both via a projected volume at `/etc/pgbouncer` and set `command: ["/usr/bin/pgbouncer","/etc/pgbouncer/pgbouncer.ini"]`. Admission mutation re-applies on every operator write, so there is no reconcile-drift window.

**Tech Stack:** Pepr (TypeScript admission/reconcile framework), Helm, Zarf, the Zalando postgres-operator, pgbouncer.

**Source of truth:** Design spec at `docs/superpowers/specs/2026-06-03-pgbouncer-fips-pooler-pepr-design.md`. Upstream reference: `zalando/postgres-operator` `pooler/pgbouncer.ini.tmpl` + `pooler/entrypoint.sh`.

**Note on commits:** Commit steps below are written per the skill's TDD cadence for execution time. The current session has been instructed not to commit — honor that; the executor commits per repo/user preference.

---

## Pre-flight facts (do not re-derive)

- Pooler container is `containers[0]`, name `connection-pooler`; pods labeled `application: db-connection-pooler`. Deployments: `pg-cluster-pooler`, `pg-cluster-pooler-repl`. Namespace `postgres`.
- Pooler user/schema = `pooler`/`pooler`; source Secret `pooler.pg-cluster.credentials.postgresql.acid.zalan.do` (keys `username`, `password`, base64).
- Cluster is `scram-sha-256`; pg_hba rejects non-SSL, so `server_tls_sslmode = require`.
- Distroless binary path: `/usr/bin/pgbouncer`. We omit `logfile`/`pidfile` (log to stderr, run in foreground) so the container needs no writable dirs; config mounts are read-only.
- Operator installs `pooler.user_lookup(...)` in each DB regardless of image, so `auth_query` works.

---

## File structure

- Create `src/pepr/package.json` — module manifest + Pepr dep + scripts.
- Create `src/pepr/pepr.ts` — module entrypoint registering the capability.
- Create `src/pepr/capabilities/pgbouncer-fips-pooler.ts` — Reconciler + Mutator.
- Create `src/pepr/capabilities/pgbouncer-fips-pooler.test.ts` — unit tests.
- Create `chart/templates/pgbouncer-config.yaml` — `pgbouncer.ini` ConfigMap (unicorn-gated).
- Modify `chart/values.yaml` — add `postgresql.poolerFipsConfig` defaults block.
- Modify `values/unicorn-values.yaml` — enable `postgresql.poolerFipsConfig`.
- Modify `zarf.yaml` — add Pepr component + image, gated `only.flavor: unicorn`.
- Modify `docs/configuration.md` — document FIPS-flavor pooler behavior.
- Modify `renovate.json` — track the Pepr controller image.
- Modify `tests/postgres/` + `tasks/test.yaml` — e2e regression for unicorn pooler.

---

## Task 0: Confirm FIPS Pepr controller image (prerequisite gate)

**Files:** none (investigation; record result in the spec's Risks section).

- [ ] **Step 1: Identify the Pepr image uds-core ships**

Run:
```bash
# Inspect a running uds-core install or its package definition for the pepr image
kubectl -n pepr-system get deploy -o jsonpath='{.items[*].spec.template.spec.containers[*].image}' 2>/dev/null; echo
# and/or check the pepr controller image tag uds-core pins
```
Expected: a `ghcr.io/defenseunicorns/pepr/controller:vX.Y.Z` (or registry1/cgr FIPS variant) reference.

- [ ] **Step 2: Decide image source**

If a FIPS/registry1 Pepr controller image is available, record its reference for use in `zarf.yaml` (Task 5). If NOT available, STOP and revisit the design with the user — the lift/image-sourcing changes. Do not proceed past this gate without a usable image.

**GATE RESULT (2026-06-03):** PASSED. uds-core runs `ghcr.io/defenseunicorns/pepr/controller:v1.2.0` in the live `k3d-uds` cluster (`pepr-system/pepr-uds-core`). Use that image for dev/test; the unicorn-flavor FIPS variant (cgr/registry1 Pepr controller) is a `zarf.yaml` packaging detail to finalize in Task 5, non-blocking for build/test. **Pepr is v1.x — pin the npm `pepr` dep to `1.2.0`, not `0.x`.** The live `pg-cluster-pooler` is in CrashLoopBackOff, so the fix is verifiable end-to-end here.

---

## Task 1: Scaffold the Pepr module

**Files:**
- Create: `src/pepr/package.json`
- Create: `src/pepr/pepr.ts`

- [ ] **Step 1: Create `src/pepr/package.json`**

```json
{
  "name": "pepr-pgbouncer-fips",
  "version": "0.0.1",
  "description": "Configures the distroless pgbouncer-fips connection pooler for the Zalando postgres-operator",
  "keywords": ["pepr", "k8s", "policy-engine"],
  "pepr": {
    "uuid": "pgbouncer-fips",
    "onError": "ignore",
    "webhookTimeout": 10,
    "alwaysIgnore": { "namespaces": [] },
    "includedFiles": []
  },
  "scripts": {
    "test": "vitest run",
    "build": "pepr build"
  },
  "dependencies": {
    "pepr": "1.2.0"
  },
  "devDependencies": {
    "vitest": "^1.6.0"
  }
}
```

Note: Prefer scaffolding with `npx pepr@1.2.0 init` (non-interactive flags: `--name pepr-pgbouncer-fips --uuid pgbouncer-fips --errorBehavior ignore --skip-post-init --yes` — adjust flags to the 1.2.0 CLI) so the generated `package.json`/`pepr.ts` match the v1.2.0 format exactly; then reconcile with the fields shown above. `onError: ignore` maps to `failurePolicy: Ignore` per the design. Pin `pepr` to `1.2.0` to match the controller image from Task 0.

- [ ] **Step 2: Create `src/pepr/pepr.ts`**

```typescript
import { PeprModule } from "pepr";
// eslint-disable-next-line @typescript-eslint/no-var-requires
import cfg from "./package.json";
import { PgbouncerFips } from "./capabilities/pgbouncer-fips-pooler";

new PeprModule(cfg, [PgbouncerFips]);
```

- [ ] **Step 3: Install deps and verify Pepr CLI works**

Run:
```bash
cd src/pepr && npm install && npx pepr --version
```
Expected: prints the Pepr version (matches Task 0 image).

- [ ] **Step 4: Commit**

```bash
git add src/pepr/package.json src/pepr/pepr.ts src/pepr/package-lock.json
git commit -m "feat(pepr): scaffold pgbouncer-fips module"
```

---

## Task 2: Ship the static `pgbouncer.ini` ConfigMap (chart)

**Files:**
- Create: `chart/templates/pgbouncer-config.yaml`
- Modify: `chart/values.yaml`
- Modify: `values/unicorn-values.yaml`

- [ ] **Step 1: Add values defaults to `chart/values.yaml`**

Under the `postgresql:` block, add:

```yaml
  # FIPS pooler config: rendered only when true (set by the unicorn flavor).
  # The distroless pgbouncer-fips image has no entrypoint to build pgbouncer.ini,
  # so we ship it here and the pepr module mounts it.
  poolerFipsConfig:
    enabled: false
    listenPort: 5432
    poolMode: transaction
    defaultPoolSize: 20
    reservePoolSize: 10
    maxClientConn: 10000
    maxDBConnections: 60
```

- [ ] **Step 2: Enable it in `values/unicorn-values.yaml`**

Under `postgresql:` add:

```yaml
  poolerFipsConfig:
    enabled: true
```

- [ ] **Step 3: Create `chart/templates/pgbouncer-config.yaml`**

```yaml
# Copyright 2024 Defense Unicorns
# SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Defense-Unicorns-Commercial

{{- if and .Values.postgresql.enabled .Values.postgresql.poolerFipsConfig.enabled }}
{{- $p := .Values.postgresql.poolerFipsConfig }}
apiVersion: v1
kind: ConfigMap
metadata:
  name: pgbouncer-config
  namespace: postgres
data:
  pgbouncer.ini: |
    [databases]
    * = host=pg-cluster.postgres.svc.cluster.local port=5432 auth_user=pooler
    postgres = host=pg-cluster.postgres.svc.cluster.local port=5432 auth_user=pooler

    [pgbouncer]
    pool_mode = {{ $p.poolMode }}
    listen_port = {{ $p.listenPort }}
    listen_addr = *
    admin_users = pooler
    auth_dbname = postgres
    auth_file = /etc/pgbouncer/userlist.txt
    auth_query = SELECT * FROM pooler.user_lookup($1)
    auth_type = scram-sha-256
    server_tls_sslmode = require
    log_connections = 0
    log_disconnections = 0
    max_prepared_statements = 200
    default_pool_size = {{ $p.defaultPoolSize }}
    reserve_pool_size = {{ $p.reservePoolSize }}
    max_client_conn = {{ $p.maxClientConn }}
    max_db_connections = {{ $p.maxDBConnections }}
    idle_transaction_timeout = 600
    server_login_retry = 5
    ignore_startup_parameters = extra_float_digits,options
{{- end }}
```

Notes vs upstream template: `auth_type` is `scram-sha-256` (cluster uses scram, not md5); client TLS lines and `server_tls_ca_file` removed (mesh mTLS for clients; `require` needs no CA); `logfile`/`pidfile` removed (stderr + foreground, no writable dirs); `min_pool_size` left out (upstream comments it out).

- [ ] **Step 4: Render-test ConfigMap presence (unicorn) and absence (upstream)**

Run:
```bash
helm template chart -f chart/values.yaml -f values/unicorn-values.yaml \
  --set postgresql.enabled=true --set postgresql.volume.size=10Gi \
  --set metrics.image=foo --set metrics.tag=bar \
  --show-only templates/pgbouncer-config.yaml 2>&1 | grep -c "auth_type = scram-sha-256"
```
Expected: `1`.

Run:
```bash
helm template chart -f chart/values.yaml -f values/upstream-values.yaml \
  --set postgresql.enabled=true --set postgresql.volume.size=10Gi \
  --set metrics.image=foo --set metrics.tag=bar \
  --show-only templates/pgbouncer-config.yaml 2>&1 | grep -c "kind: ConfigMap" || true
```
Expected: `0` (template renders empty for non-unicorn).

- [ ] **Step 5: Commit**

```bash
git add chart/templates/pgbouncer-config.yaml chart/values.yaml values/unicorn-values.yaml
git commit -m "feat(chart): add unicorn-gated pgbouncer.ini ConfigMap for FIPS pooler"
```

---

## Task 3: Pepr Reconciler — derived `userlist.txt` Secret

**Files:**
- Create: `src/pepr/capabilities/pgbouncer-fips-pooler.ts` (Reconciler portion)
- Create: `src/pepr/capabilities/pgbouncer-fips-pooler.test.ts`

- [ ] **Step 1: Write the failing unit test for userlist rendering**

`src/pepr/capabilities/pgbouncer-fips-pooler.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { renderUserlist } from "./pgbouncer-fips-pooler";

describe("renderUserlist", () => {
  it("formats a pgbouncer auth_file line from username/password", () => {
    expect(renderUserlist("pooler", "s3cr3t")).toBe('"pooler" "s3cr3t"\n');
  });

  it("escapes embedded double quotes in the password", () => {
    expect(renderUserlist("pooler", 'pa"ss')).toBe('"pooler" "pa""ss"\n');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/pepr && npx vitest run capabilities/pgbouncer-fips-pooler.test.ts`
Expected: FAIL — `renderUserlist` is not exported / not defined.

- [ ] **Step 3: Create the capability file with the Reconciler + `renderUserlist`**

`src/pepr/capabilities/pgbouncer-fips-pooler.ts`:

```typescript
import { Capability, a, K8s, kind, Log } from "pepr";

export const PgbouncerFips = new Capability({
  name: "pgbouncer-fips-pooler",
  description: "Configures the distroless pgbouncer-fips connection pooler.",
  namespaces: ["postgres"],
});

const { When } = PgbouncerFips;

const SOURCE_SECRET = "pooler.pg-cluster.credentials.postgresql.acid.zalan.do";
const DERIVED_SECRET = "pgbouncer-fips-userlist";
const NS = "postgres";

// pgbouncer auth_file format: `"user" "password"` with "" escaping inside quotes.
export function renderUserlist(username: string, password: string): string {
  const esc = (s: string) => s.replace(/"/g, '""');
  return `"${esc(username)}" "${esc(password)}"\n`;
}

// Reconcile the operator's pooler credential Secret into a derived userlist Secret.
When(a.Secret)
  .IsCreatedOrUpdated()
  .InNamespace(NS)
  .WithName(SOURCE_SECRET)
  // Reconcile (not Watch): ordered, idempotent queue — the operator pattern for
  // creating/owning derived resources.
  .Reconcile(async secret => {
    const data = secret.data ?? {};
    if (!data.username || !data.password) {
      Log.warn(`${SOURCE_SECRET} missing username/password; skipping`);
      return;
    }
    const username = Buffer.from(data.username, "base64").toString("utf8");
    const password = Buffer.from(data.password, "base64").toString("utf8");

    await K8s(kind.Secret).Apply({
      metadata: {
        name: DERIVED_SECRET,
        namespace: NS,
        ownerReferences: [
          {
            apiVersion: "v1",
            kind: "Secret",
            name: secret.metadata!.name!,
            uid: secret.metadata!.uid!,
            controller: false,
            blockOwnerDeletion: false,
          },
        ],
      },
      stringData: { "userlist.txt": renderUserlist(username, password) },
    });
    Log.info(`reconciled ${DERIVED_SECRET} from ${SOURCE_SECRET}`);
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/pepr && npx vitest run capabilities/pgbouncer-fips-pooler.test.ts`
Expected: PASS (both `renderUserlist` cases).

- [ ] **Step 5: Commit**

```bash
git add src/pepr/capabilities/pgbouncer-fips-pooler.ts src/pepr/capabilities/pgbouncer-fips-pooler.test.ts
git commit -m "feat(pepr): reconcile pooler secret into pgbouncer userlist secret"
```

---

## Task 4: Pepr Mutator — inject config + command into the pooler Deployment

**Files:**
- Modify: `src/pepr/capabilities/pgbouncer-fips-pooler.ts` (add Mutator + helper)
- Modify: `src/pepr/capabilities/pgbouncer-fips-pooler.test.ts` (add mutation tests)

- [ ] **Step 1: Write failing tests for the mutation helper**

Append to `src/pepr/capabilities/pgbouncer-fips-pooler.test.ts`:

```typescript
import { applyPoolerPatch } from "./pgbouncer-fips-pooler";

function poolerDeployment(): any {
  return {
    spec: {
      template: {
        spec: {
          volumes: [],
          containers: [{ name: "connection-pooler", image: "cgr.dev/x/pgbouncer-fips:v1", volumeMounts: [] }],
        },
      },
    },
  };
}

describe("applyPoolerPatch", () => {
  it("sets the pgbouncer command on containers[0]", () => {
    const d = poolerDeployment();
    applyPoolerPatch(d);
    expect(d.spec.template.spec.containers[0].command).toEqual([
      "/usr/bin/pgbouncer",
      "/etc/pgbouncer/pgbouncer.ini",
    ]);
  });

  it("adds a projected /etc/pgbouncer volume + mount", () => {
    const d = poolerDeployment();
    applyPoolerPatch(d);
    const vol = d.spec.template.spec.volumes.find((v: any) => v.name === "pgbouncer-fips");
    expect(vol.projected.sources).toHaveLength(2);
    const mount = d.spec.template.spec.containers[0].volumeMounts.find(
      (m: any) => m.name === "pgbouncer-fips",
    );
    expect(mount.mountPath).toBe("/etc/pgbouncer");
    expect(mount.readOnly).toBe(true);
  });

  it("is idempotent (no duplicate volume/mount on second apply)", () => {
    const d = poolerDeployment();
    applyPoolerPatch(d);
    applyPoolerPatch(d);
    expect(d.spec.template.spec.volumes.filter((v: any) => v.name === "pgbouncer-fips")).toHaveLength(1);
    expect(
      d.spec.template.spec.containers[0].volumeMounts.filter((m: any) => m.name === "pgbouncer-fips"),
    ).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src/pepr && npx vitest run capabilities/pgbouncer-fips-pooler.test.ts`
Expected: FAIL — `applyPoolerPatch` not exported.

- [ ] **Step 3: Add `applyPoolerPatch` + the Mutator to the capability file**

Append to `src/pepr/capabilities/pgbouncer-fips-pooler.ts`:

```typescript
const VOLUME = "pgbouncer-fips";
const CONFIG_MAP = "pgbouncer-config";

// Pure, idempotent mutation of a pooler Deployment object.
export function applyPoolerPatch(d: any): void {
  const podSpec = d?.spec?.template?.spec;
  if (!podSpec || !Array.isArray(podSpec.containers) || podSpec.containers.length === 0) {
    return;
  }
  podSpec.volumes = podSpec.volumes ?? [];
  if (!podSpec.volumes.some((v: any) => v.name === VOLUME)) {
    podSpec.volumes.push({
      name: VOLUME,
      projected: {
        sources: [
          { configMap: { name: CONFIG_MAP, items: [{ key: "pgbouncer.ini", path: "pgbouncer.ini" }] } },
          { secret: { name: DERIVED_SECRET, items: [{ key: "userlist.txt", path: "userlist.txt" }] } },
        ],
      },
    });
  }

  const c = podSpec.containers[0]; // connection-pooler is containers[0]
  c.volumeMounts = c.volumeMounts ?? [];
  if (!c.volumeMounts.some((m: any) => m.name === VOLUME)) {
    c.volumeMounts.push({ name: VOLUME, mountPath: "/etc/pgbouncer", readOnly: true });
  }
  c.command = ["/usr/bin/pgbouncer", "/etc/pgbouncer/pgbouncer.ini"];
}

// Mutate every pooler Deployment in the postgres namespace (unicorn-only deploy).
When(a.Deployment)
  .IsCreatedOrUpdated()
  .InNamespace(NS)
  .WithLabel("application", "db-connection-pooler")
  .Mutate(request => {
    applyPoolerPatch(request.Raw);
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src/pepr && npx vitest run capabilities/pgbouncer-fips-pooler.test.ts`
Expected: PASS (all 5 tests: 2 userlist + 3 mutation).

- [ ] **Step 5: Commit**

```bash
git add src/pepr/capabilities/pgbouncer-fips-pooler.ts src/pepr/capabilities/pgbouncer-fips-pooler.test.ts
git commit -m "feat(pepr): mutate pooler deployment to mount config and set pgbouncer command"
```

---

## Task 5: Build the module and wire it into Zarf (unicorn-gated)

**Files:**
- Modify: `zarf.yaml`

- [ ] **Step 1: Build the Pepr module**

Run:
```bash
cd src/pepr && npx pepr build
```
Expected: produces `src/pepr/dist/` containing `pepr-module-pgbouncer-fips.yaml` (manifests) and prints the controller image used.

- [ ] **Step 2: Add a flavor-gated component to `zarf.yaml`**

Add a component (place near the existing config component). Use the manifests produced by `pepr build` and the controller image confirmed in Task 0:

```yaml
  - name: pgbouncer-fips-pooler
    description: "Pepr module configuring the distroless pgbouncer-fips pooler"
    required: false
    only:
      flavor: unicorn
    manifests:
      - name: pepr-pgbouncer-fips
        namespace: pepr-pgbouncer-fips
        files:
          - src/pepr/dist/pepr-module-pgbouncer-fips.yaml
    images:
      - "<PEPR_CONTROLLER_IMAGE_FROM_TASK_0>"
```

Replace `<PEPR_CONTROLLER_IMAGE_FROM_TASK_0>` with the exact reference recorded in Task 0. If `pepr build` emits a different manifest filename, use that exact path.

- [ ] **Step 3: Validate the package builds for unicorn and excludes the component elsewhere**

Run:
```bash
zarf dev inspect manifests . --flavor unicorn 2>&1 | grep -c "pepr-module-pgbouncer-fips" || true
```
Expected: `>= 1` for unicorn.

Run:
```bash
zarf dev inspect manifests . --flavor upstream 2>&1 | grep -c "pepr-pgbouncer-fips" || true
```
Expected: `0`.

(If `zarf dev inspect manifests` cannot resolve the component, fall back to `zarf package create . --flavor unicorn --confirm -o /tmp` and inspect the built package's `zarf.yaml`.)

- [ ] **Step 4: Commit**

```bash
git add zarf.yaml src/pepr/dist
git commit -m "feat(zarf): deploy pgbouncer-fips pepr module on unicorn flavor"
```

---

## Task 6: e2e regression test (unicorn pooler runs and proxies)

**Files:**
- Modify: `tests/postgres/postgres-minimal.yaml` or add `tests/postgres/pooler-fips-test.yaml`
- Modify: `tasks/test.yaml`

- [ ] **Step 1: Add an e2e assertion that the pooler pod runs (not usage-exit)**

Add a test task in `tasks/test.yaml` (match existing task style). The assertion: after deploying the unicorn flavor with pooling enabled, the pooler pods become Ready.

```yaml
  - name: validate-fips-pooler
    description: "pgbouncer-fips pooler pods start and accept connections"
    actions:
      - cmd: |
          kubectl -n postgres rollout status deployment/pg-cluster-pooler --timeout=180s
      - description: "Pooler proxies a query (auth via auth_query)"
        cmd: |
          kubectl -n postgres run pooler-smoke-$RANDOM --rm -i --restart=Never \
            --image=$(yq '.postgresql.connection_pooler_image' values/unicorn-values.yaml) \
            --command -- /usr/bin/pgbouncer --version
```

Note: the second action only proves the binary runs; the authoritative check is the existing through-pooler psql connectivity test in `tests/postgres/`. Wire `validate-fips-pooler` to run after the existing pooler routing test in the unicorn test flow.

- [ ] **Step 2: Extend/confirm the existing pooler connectivity test targets the pooler service**

Confirm `tests/postgres/` pooler routing test connects via the pooler Service (`pg-cluster-pooler.postgres.svc`) and runs a `SELECT`. If it currently only runs for non-unicorn, add a unicorn invocation in `tasks/test.yaml`.

- [ ] **Step 3: Run the unicorn e2e flow locally (if a cluster is available)**

Run:
```bash
uds run test:<unicorn-pooler-task>   # match the actual task name in tasks/test.yaml
```
Expected: pooler rollout succeeds; through-pooler `SELECT` returns rows (no usage-exit, no auth failure).

- [ ] **Step 4: Commit**

```bash
git add tasks/test.yaml tests/postgres
git commit -m "test: verify pgbouncer-fips pooler runs and proxies on unicorn"
```

---

## Task 7: Docs + automation wiring

**Files:**
- Modify: `docs/configuration.md`
- Modify: `renovate.json`

- [ ] **Step 1: Document the FIPS pooler behavior**

In `docs/configuration.md`, in the connection pooler section, add a subsection: on the `unicorn` (FIPS) flavor the pooler image is distroless and is configured by the bundled Pepr module (`pgbouncer-fips-pooler`); client→pooler encryption is provided by the service mesh (mTLS), pooler→postgres uses `server_tls_sslmode=require`, and auth uses `scram-sha-256` via `auth_query`. Note that pool sizes are set via `postgresql.poolerFipsConfig.*` rather than the operator's dynamic sizing.

- [ ] **Step 2: Track the Pepr controller image in renovate**

In `renovate.json`, add a rule (matching existing patterns) so the Pepr controller image reference in `zarf.yaml` is updated by renovate. If the repo pins images via a custom manager/regex, mirror that for the new image.

- [ ] **Step 3: Lint**

Run:
```bash
uds run lint  # or the repo's lint task; match tasks.yaml
```
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add docs/configuration.md renovate.json
git commit -m "docs: document FIPS pooler; chore: track pepr image in renovate"
```

---

## Self-Review

**Spec coverage:**
- Image-compatibility root cause → Tasks 2–5 (config + mutation + command).
- Module scope (unicorn-only, mutate all poolers) → Task 5 `only.flavor: unicorn`; Mutator has no image gate (Task 4).
- Client TLS via mesh / server `require` → Task 2 ConfigMap.
- Pepr-derived userlist Secret → Task 3.
- `failurePolicy: Ignore` → Task 1 `onError: ignore`.
- Static `pgbouncer.ini` in chart, unicorn-gated → Task 2.
- Data-flow/ordering (by-name refs, kubelet volume-wait) → Task 4 (refs by name) + Task 6 (cold-deploy).
- Idempotency → Task 4 Step 1 test.
- Testing (unit + e2e + flavor gating) → Tasks 3, 4, 6; gating assertions Task 2 Step 4 / Task 5 Step 3.
- Packaging/layout/docs/renovate → Tasks 1, 5, 7.
- FIPS Pepr image risk → Task 0 gate.

**Placeholder scan:** One intentional placeholder — `<PEPR_CONTROLLER_IMAGE_FROM_TASK_0>` (resolved by Task 0) and the test/lint task names which must match `tasks/test.yaml`/`tasks.yaml`. All code steps contain real code.

**Type consistency:** `DERIVED_SECRET`, `CONFIG_MAP`, `VOLUME`, `renderUserlist`, `applyPoolerPatch`, `PgbouncerFips` are used consistently across Tasks 3–4 and tests. Container index 0 / name `connection-pooler` consistent with pre-flight facts.

## Open items the executor must resolve against the live repo
- Exact `pepr` package version + matching controller image (Task 0/1/5).
- Exact `pepr build` output filename (Task 5 Step 2).
- Actual task names in `tasks/test.yaml` / `tasks.yaml` for lint + e2e (Tasks 6, 7).
- Confirm `tests/postgres/` pooler routing test's connection target (Task 6 Step 2).
