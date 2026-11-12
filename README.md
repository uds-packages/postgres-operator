# UDS Postgres Operator Package

This package is designed for use in a UDS CLI Next bundle deployed on [UDS Core](https://github.com/defenseunicorns/uds-core). See the [test bundle configuration](./docs/configuration.md#test-bundle-configuration).

> The Postgres Operator is a software tool that automates the deployment and management of PostgreSQL databases on Kubernetes, simplifying the process of setting up and maintaining highly available and scalable PostgreSQL clusters.

## Prerequisites

This package requires a Kubernetes Cluster providing a Storage Class that has [UDS Core](https://github.com/defenseunicorns/uds-core) installed into it.  You can learn more about configuring this package in the [configuration documentation](./docs/configuration.md)

## Releases

The released packages can be found in [ghcr](https://github.com/uds-packages/postgres-operator/pkgs/container/postgres-operator)).

### Verify a Package

Packages are signed using [Zarf's Keyless Signing](https://docs.zarf.dev/ref/package-signing/#using-keyless-signing).

Packages are signed from the following versions onwards:

| Flavor | First Signed Version |
| --- | --- |
| `upstream` | `2.0.3-uds.6` |
| `registry1` | `2.0.2-uds.14` |
| `unicorn` | `2.0.3-uds.14` |

To verify a package, follow the below example:

```bash
uds zarf package verify "oci://ghcr.io/uds-packages/postgres-operator:2.0.3-uds.6-upstream" \
  --certificate-identity "https://github.com/uds-packages/postgres-operator/.github/workflows/release.yaml@refs/heads/main" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com"
```

For a `unicorn` package, use `oci://ghcr.io/uds-packages/private/postgres-operator:<VERSION>-unicorn`
as the package source.

## UDS Tasks (for local dev and CI)

For local dev, install [uds-cli](https://github.com/defenseunicorns/uds-cli?tab=readme-ov-file#install) v0.40.0 or later. Tasks enable CLI Next by default.

After installing uds-cli, for a list of available tasks that can be run in this repository execute the following command:

`uds run --list`

## Contributing

Please see the [CONTRIBUTING.md](./CONTRIBUTING.md)

## Development

Use JSON schemas for Zarf package and task YAML files. CLI Next bundle and deploy configuration use HCL in [`bundle/bundle.uds.hcl`](./bundle/bundle.uds.hcl) and [`bundle/config.uds.hcl`](./bundle/config.uds.hcl).
