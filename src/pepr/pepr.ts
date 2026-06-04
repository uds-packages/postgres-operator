// Copyright 2024 Defense Unicorns
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Defense-Unicorns-Commercial

import { PeprModule } from "pepr";
import cfg from "./package.json";
import { Pgbouncer } from "./capabilities/pgbouncer-pooler";

new PeprModule(cfg, [Pgbouncer]);
