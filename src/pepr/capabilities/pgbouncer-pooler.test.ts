import { describe, it, expect } from "vitest";
import { a } from "pepr";
import { renderUserlist, applyPoolerPatch, needsBootstrap } from "./pgbouncer-pooler";

describe("renderUserlist", () => {
  it("formats a pgbouncer auth_file line from username/password", () => {
    expect(renderUserlist("pooler", "s3cr3t")).toBe('"pooler" "s3cr3t"\n');
  });

  it("escapes embedded double quotes in the password", () => {
    expect(renderUserlist("pooler", 'pa"ss')).toBe('"pooler" "pa""ss"\n');
  });
});

function poolerDeployment(): a.Deployment {
  return {
    spec: {
      template: {
        spec: {
          volumes: [],
          containers: [{ name: "connection-pooler", image: "cgr.dev/x/pgbouncer:v1", volumeMounts: [] }],
        },
      },
    },
  } as unknown as a.Deployment;
}

describe("applyPoolerPatch", () => {
  it("sets the pgbouncer command on containers[0]", () => {
    const d = poolerDeployment();
    applyPoolerPatch(d);
    expect(d.spec!.template.spec!.containers[0].command).toEqual([
      "/usr/bin/pgbouncer",
      "/etc/pgbouncer/pgbouncer.ini",
    ]);
  });

  it("adds a projected /etc/pgbouncer volume + mount", () => {
    const d = poolerDeployment();
    applyPoolerPatch(d);
    const vol = d.spec!.template.spec!.volumes!.find(v => v.name === "pgbouncer");
    expect(vol!.projected!.sources).toHaveLength(2);
    const mount = d.spec!.template.spec!.containers[0].volumeMounts!.find(
      m => m.name === "pgbouncer",
    );
    expect(mount!.mountPath).toBe("/etc/pgbouncer");
    expect(mount!.readOnly).toBe(true);
  });

  it("is idempotent (no duplicate volume/mount on second apply)", () => {
    const d = poolerDeployment();
    applyPoolerPatch(d);
    applyPoolerPatch(d);
    expect(d.spec!.template.spec!.volumes!.filter(v => v.name === "pgbouncer")).toHaveLength(1);
    expect(
      d.spec!.template.spec!.containers[0].volumeMounts!.filter(m => m.name === "pgbouncer"),
    ).toHaveLength(1);
  });
});

describe("needsBootstrap", () => {
  it("returns false for a Deployment already carrying the pgbouncer volume", () => {
    const d = poolerDeployment();
    applyPoolerPatch(d);
    expect(needsBootstrap(d)).toBe(false);
  });

  it("returns true for a fresh, unmutated pooler Deployment", () => {
    const d = poolerDeployment();
    expect(needsBootstrap(d)).toBe(true);
  });

  it("returns false for a Deployment with no containers / empty spec", () => {
    const empty = {} as unknown as a.Deployment;
    expect(needsBootstrap(empty)).toBe(false);

    const noContainers = {
      spec: { template: { spec: { volumes: [], containers: [] } } },
    } as unknown as a.Deployment;
    expect(needsBootstrap(noContainers)).toBe(false);
  });
});
