# pgbouncer entrypoint script

The `entrypoint.sh` script that upstream Zalando pgbouncer image uses is as follows:

```bash
#!/bin/sh

set -ex

if [ "$PGUSER" = "postgres" ]; then
    echo "WARNING: pgbouncer will connect with a superuser privileges!"
    echo "You need to fix this as soon as possible."
fi

if [ -z "${CONNECTION_POOLER_CLIENT_TLS_CRT}" ]; then
    openssl req -nodes -new -x509 -subj /CN=spilo.dummy.org \
        -keyout /etc/ssl/certs/pgbouncer.key \
        -out /etc/ssl/certs/pgbouncer.crt
else
    ln -s ${CONNECTION_POOLER_CLIENT_TLS_CRT} /etc/ssl/certs/pgbouncer.crt
    ln -s ${CONNECTION_POOLER_CLIENT_TLS_KEY} /etc/ssl/certs/pgbouncer.key
    if [ ! -z "${CONNECTION_POOLER_CLIENT_CA_FILE}" ]; then
        ln -s ${CONNECTION_POOLER_CLIENT_CA_FILE} /etc/ssl/certs/ca.crt
    fi
fi

envsubst < /etc/pgbouncer/pgbouncer.ini.tmpl > /etc/pgbouncer/pgbouncer.ini
envsubst < /etc/pgbouncer/auth_file.txt.tmpl > /etc/pgbouncer/auth_file.txt

exec /bin/pgbouncer /etc/pgbouncer/pgbouncer.ini
```

The Chainguard image for pgbouncer only contains the binary, so we need to explictly define the `pgbouncer.ini` and `auth_file.txt`. First, let's define what the template file (`pgbouncer.ini.tmpl`) looks like:

```bash
# vim: set ft=dosini:

[databases]
* = host=$PGHOST port=$PGPORT auth_user=$PGUSER
postgres = host=$PGHOST port=$PGPORT auth_user=$PGUSER

[pgbouncer]
pool_mode = $CONNECTION_POOLER_MODE
listen_port = $CONNECTION_POOLER_PORT
listen_addr = *
auth_type = md5
auth_file = /etc/pgbouncer/auth_file.txt
auth_dbname = postgres
admin_users = $PGUSER
stats_users_prefix = robot_
auth_query = SELECT * FROM $PGSCHEMA.user_lookup($1)
logfile = /var/log/pgbouncer/pgbouncer.log
pidfile = /var/run/pgbouncer/pgbouncer.pid

server_tls_sslmode = require
server_tls_ca_file = /etc/ssl/certs/pgbouncer.crt
server_tls_protocols = secure
client_tls_sslmode = require
client_tls_key_file = /etc/ssl/certs/pgbouncer.key
client_tls_cert_file = /etc/ssl/certs/pgbouncer.crt

log_connections = 0
log_disconnections = 0

# How many server connections to allow per user/database pair.
default_pool_size = $CONNECTION_POOLER_DEFAULT_SIZE

# Add more server connections to pool if below this number. Improves behavior
# when usual load comes suddenly back after period of total inactivity.
#
# NOTE: This value is per pool, i.e. a pair of (db, user), not a global one.
# Which means on the higher level it has to be calculated from the max allowed
# database connections and number of databases and users. If not taken into
# account, then for too many users or databases PgBouncer will go crazy
# opening/evicting connections. For now disable it.
#
# min_pool_size = $CONNECTION_POOLER_MIN_SIZE

# How many additional connections to allow to a pool
reserve_pool_size = $CONNECTION_POOLER_RESERVE_SIZE

# Maximum number of client connections allowed.
max_client_conn = $CONNECTION_POOLER_MAX_CLIENT_CONN

# Do not allow more than this many connections per database (regardless of
# pool, i.e. user)
max_db_connections = $CONNECTION_POOLER_MAX_DB_CONN

# If a client has been in "idle in transaction" state longer, it will be
# disconnected. [seconds]
idle_transaction_timeout = 600

# If login failed, because of failure from connect() or authentication that
# pooler waits this much before retrying to connect. Default is 15. [seconds]
server_login_retry = 5

# To ignore extra parameter in startup packet. By default only 'database' and
# 'user' are allowed, all others raise error.  This is needed to tolerate
# overenthusiastic JDBC wanting to unconditionally set 'extra_float_digits=2'
# in startup packet.
ignore_startup_parameters = extra_float_digits,options
```

According to this we have created a task to explictly create this file in [unicorn-pooler-patch.yaml](../tasks/unicorn-pooler-patch.yaml).
