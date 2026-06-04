// Copyright 2024 Defense Unicorns
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Defense-Unicorns-Commercial

import { Capability, a, K8s, kind, Log } from "pepr";

export const Pgbouncer = new Capability({
  name: "pgbouncer-pooler",
  description: "Configures the distroless pgbouncer connection pooler.",
  namespaces: ["postgres"],
});

const { When } = Pgbouncer;

// Exported for reuse by the Mutator task.
export const NS = "postgres";
export const SOURCE_SECRET = "pooler.pg-cluster.credentials.postgresql.acid.zalan.do";
export const DERIVED_SECRET = "pgbouncer-userlist";

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

const VOLUME = "pgbouncer";
const CONFIG_MAP = "pgbouncer-config";

// Pure, idempotent mutation of a pooler Deployment object.
export function applyPoolerPatch(d: a.Deployment): void {
  const podSpec = d?.spec?.template?.spec;
  if (!podSpec || !Array.isArray(podSpec.containers) || podSpec.containers.length === 0) {
    return;
  }
  podSpec.volumes = podSpec.volumes ?? [];
  if (!podSpec.volumes.some(v => v.name === VOLUME)) {
    podSpec.volumes.push({
      name: VOLUME,
      projected: {
        sources: [
          {
            configMap: {
              name: CONFIG_MAP,
              items: [{ key: "pgbouncer.ini", path: "pgbouncer.ini" }],
            },
          },
          {
            secret: {
              name: DERIVED_SECRET,
              items: [{ key: "userlist.txt", path: "userlist.txt" }],
            },
          },
        ],
      },
    });
  }

  const c = podSpec.containers[0]; // connection-pooler is containers[0]
  c.volumeMounts = c.volumeMounts ?? [];
  if (!c.volumeMounts.some(m => m.name === VOLUME)) {
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

// Bootstrap support: the Mutate webhook above only fires on Deployment CREATE/UPDATE.
// When this module is deployed onto an already-running cluster, the operator's pooler
// Deployment already exists and is not mutated until the operator's next write to it.
// The Reconcile handler below processes PRE-EXISTING resources on module startup; for any
// pooler Deployment that has not yet been mutated, it "touches" the pod template so an
// UPDATE fires and the Mutate webhook enriches it. needsBootstrap acts as the loop guard.

// True when a pooler Deployment has not yet been mutated (no pgbouncer volume).
export function needsBootstrap(d: a.Deployment): boolean {
  const podSpec = d?.spec?.template?.spec;
  if (!podSpec || !Array.isArray(podSpec.containers) || podSpec.containers.length === 0) {
    return false;
  }
  const volumes = podSpec.volumes ?? [];
  return !volumes.some(v => v.name === VOLUME);
}

// Touch pre-existing pooler Deployments so the Mutate webhook enriches them on startup.
When(a.Deployment)
  .IsCreatedOrUpdated()
  .InNamespace(NS)
  .WithLabel("application", "db-connection-pooler")
  .Reconcile(async deploy => {
    const name = deploy.metadata?.name;
    if (!name) {
      return;
    }
    // Loop guard: once the Mutate webhook has added the pgbouncer volume, stop touching.
    if (!needsBootstrap(deploy)) {
      return;
    }
    // Server-side apply of a partial object: we only own the single bootstrap annotation,
    // so this merges into the existing pod-template annotations (creating the map if absent)
    // without clobbering other annotations or fighting the operator over fields we don't set.
    await K8s(kind.Deployment).Apply(
      {
        metadata: { name, namespace: NS },
        spec: {
          template: {
            metadata: { annotations: { "pgbouncer.pepr.dev/bootstrap": `${Date.now()}` } },
          },
        },
      },
      { force: true },
    );
    Log.info(`bootstrapped pre-existing pooler deployment ${name}`);
  });
