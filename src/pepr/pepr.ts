import { PeprModule } from "pepr";
import cfg from "./package.json";
import { Pgbouncer } from "./capabilities/pgbouncer-pooler";

new PeprModule(cfg, [Pgbouncer]);
