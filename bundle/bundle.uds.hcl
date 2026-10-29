# Copyright 2026 Defense Unicorns
# SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Defense-Unicorns-Commercial

uds {
  bundle_api_version = "uds.dev/v1alpha1"
}

metadata {
  name        = "postgres-operator-test"
  description = "A UDS bundle for deploying Zalando Postgres Operator on a development cluster"
  version     = "dev"
}

package "postgres-operator" {
  source       = "../zarf-package-postgres-operator-${sys.arch}-dev.tar.zst"
  values_files = ["values/postgres-operator.yaml"]

  signature_verification {
    verify = false
  }
}
