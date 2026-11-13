# Reader deployment, provisioning, and recovery

This package runs ts-data-api, HAProxy, and Mosquitto in Linux containers. MongoDB
Atlas/a replica set and compatible Rails remain external. The same commands work
on Linux Docker Engine and Windows Docker Desktop in **Linux-container mode**.

All issued CA, server, and reader certificates expire on their twentieth UTC
calendar anniversary. Private keys and reader identities are persistent deployment
state. Rebuilding an image, rendering configuration, or restoring an archive does
not create replacement identities or card credentials.

Build a reviewed, committed source revision for deployment. The wrappers label
uncommitted source as `-dirty`; a recovery archive preserves version identifiers,
not a copy of the application source checkout.

## 1. Install prerequisites and choose addresses

Install Git, Docker Engine/Desktop, and Docker Compose v2 with `up --wait` support.
On Windows, enable the Docker Desktop WSL2 backend before running this guide.
No host installation of Node, OpenSSL, age, or MongoDB tools is needed to deploy.
The wrappers build an on-demand tools container; allow Docker registry, Debian,
and MongoDB package repository access during the first build.

Clone this repository and run commands from its root. Use a local disk for the
checkout/state directory. Avoid cloud-synchronized folders for private keys.

Choose these site-specific values before issuing certificates:

| Value | Example | Purpose |
| --- | --- | --- |
| API DNS | `reader-api.example.org` | Reader HTTPS origin, port 443 |
| Reader MQTT DNS | `reader-mqtt.example.org` | Reader mTLS 8883 |
| Service MQTT DNS | `reader-mqtt-service.example.org` | Private service TLS 8884 for Rails |
| Management DNS suffix | `readers.example.org` | One hostname per reader, port 8443 |
| Reader interface | `192.168.20.10` | Host address publishing 443 and 8883 |
| Management interface | `192.168.10.10` | Host address publishing 8443 and 8884 |
| Management networks | `192.168.10.0/24` | HAProxy source-address allowlist |
| Reader address | `192.168.20.101` | DHCP reservation/private HTTP backend |
| Rails origin | `https://rails.internal.example.org` | Reservation lifecycle service |
| Database | `makerspace` | Same application data used by Rails |

The current configuration supports explicit private IPv4 host/backend addresses
and DNS TLS names. Do not use `0.0.0.0` for host bindings. Point API/MQTT DNS at the
reader-facing address and management/service-MQTT DNS at the management-facing
address. The broker certificate covers both MQTT names plus internal `mosquitto`.
Rails uses the service hostname because port 8884 binds only to the private
management interface; readers use the reader hostname on port 8883.
Management names are exactly one label below the configured suffix, covered by
its wildcard certificate. Keep DNS names stable to avoid rebuilding firmware.

Permit the reader network to reach API 443, MQTT 8883, DNS, DHCP, and bootstrap NTP
(`pool.ntp.org` / `time.cloudflare.com`, UDP 123). Permit the management network to
reach 8443, and Rails to reach private MQTT 8884. HAProxy must reach each reader's
port 80. Limit that HTTP segment to the isolated management/reader network. Allow
API egress to MongoDB and Rails. Never publish API port 8080 or plaintext MQTT 1883.

Docker Desktop/VPN/NAT can change the source address seen by HAProxy. Check this
before commissioning; add only the actual trusted management subnet, not a global
allowlist. Host firewall rules must also restrict the published service ports.

## 2. Prepare protected inputs and external services

Run the wrapper once to create protected input/state/export directories:

```bash
bash deploy/deploy.sh help
cp deploy/deployment.example.json deployment-input/deployment.json
cp deploy/reader.example.json deployment-input/reader-01.json
```

```powershell
./deploy/deploy.ps1 help
Copy-Item deploy/deployment.example.json deployment-input/deployment.json
Copy-Item deploy/reader.example.json deployment-input/reader-01.json
```

Edit `deployment-input/deployment.json` with the chosen names and addresses. In a
local editor, create `deployment-input/mongodb-uri.txt` containing only the MongoDB
URI. Never paste it into a command argument. Percent-encode URI password characters
as required by MongoDB; use TLS/Atlas SRV configuration and its network allowlist.

Use an account scoped to this application database. It needs reads/change streams,
reader/card enrollment updates, and event/credential writes. The operator account
used for `indexes` additionally needs index creation. The built-in `readWrite` role
on this one database is a straightforward starting point; do not use cluster-admin
credentials for the API. Enrollment requires transactions, so standalone MongoDB
is unsupported. Configure a separate target account/database for retesting.

Rails must already implement
`POST /api/internal/reader_reservations/sync`, including reservation lifecycle,
reader participation, and attendance evidence semantics. The Rails `master` branch
inspected during planning did not contain this endpoint. This package does not
implement it. A successful HTTP connection to Rails is not proof of compatibility;
step 8 tests the actual endpoint with an authenticated Tool reader.

If Rails already has a reservation service secret, place that exact value in
`deployment-input/rails-secret.txt` (at least 32 printable characters). Otherwise
the initializer generates one to install on Rails. If Rails uses another private
CA, put its **public** CA bundle in `deployment-input/additional-ca.pem` and pass
`--additional-ca-file /input/additional-ca.pem` to `init`.

## 3. Initialize once

```bash
bash deploy/deploy.sh init --config /input/deployment.json --mongo-uri-file /input/mongodb-uri.txt
```

```powershell
./deploy/deploy.ps1 init --config /input/deployment.json --mongo-uri-file /input/mongodb-uri.txt
```

Append `--rails-secret-file /input/rails-secret.txt` to reuse an existing Rails
secret. For an existing card deployment, also pass `--card-key-file /input/card-key.txt`
with its original Base64 32-byte key. New installations generate that key once.
Preflight checks every stored encrypted card credential against the configured key;
a mismatch is an error, never an instruction to reinitialize cards.

Expected result: `init completed`, with no secret values printed. It refuses to
initialize a nonempty state directory. The first run creates:

| Location under `.deployment` | Contents |
| --- | --- |
| `state.json` | Private canonical inventory, credentials, build/image provenance |
| `pki/` | CA certificates/private keys, issued certificates, serials and CRLs |
| `certificates/` | API/management and broker certificates/private keys |
| `runtime/` | Generated HAProxy/Mosquitto configuration and selected service secrets |
| `compose.env` | Non-secret Compose settings |
| `rails-handoff.json` | Private reservation secret and Rails MQTT connection details |
| `readers/<ObjectId>/` | Per-reader credentials and generated firmware header |

Copy the reservation secret from the private handoff file into Rails'
`READER_RESERVATION_SERVICE_SECRET`; set the matching variable on Rails, not in
firmware. Configure Rails' MQTT integration using the handoff URL, `rails` username,
password and CA file. Its ACL permits `reservations/#` publications and the existing
activity/checkin/checkend subscriptions. Rails must use this new broker for its
reservation hints; the API's MongoDB change stream also supplies refresh fallbacks.

Only runtime leaf keys and selected secrets are mounted into services. CA private
keys remain in state and are never mounted into API, HAProxy, or Mosquitto.
Runtime files use readable file modes inside the container because Compose bind
secrets do not remap ownership. Their **host parent directory is private** and each
container receives only explicit read-only files. Keep the `.deployment` directory
mode 0700 on Linux; the Windows wrapper restricts ACLs to your account and SYSTEM.

## 4. Export the initial recovery material

```bash
bash deploy/deploy.sh export --output /transfer/initial.tar.age
```

```powershell
./deploy/deploy.ps1 export --output /transfer/initial.tar.age
```

age prompts for an archive passphrase in the terminal. Save the resulting
`deployment-transfer/initial.tar.age` in your backup system. Keep the passphrase
separately. For unattended exports, append `--recipient age1...` and keep the matching
age identity file offline. Export refuses to overwrite an existing archive.

The archive contains all generated master/private keys, certificates, service and
web secrets, reader inventory/headers, issuer state, image/source versions, and a
versioned integrity manifest. It does **not** require a CA key or password to be
recreated. It is sufficient to rebuild server credentials; preserving cards also
requires their MongoDB credential records, as described in step 12.

Test the archive immediately in a separate empty state directory:

```bash
READER_DEPLOY_STATE="$PWD/.deployment-export-check" bash deploy/deploy.sh restore --input /transfer/initial.tar.age --mode rebuild
READER_DEPLOY_STATE="$PWD/.deployment-export-check" bash deploy/deploy.sh preflight --offline
```

```powershell
$savedDeployState = $env:READER_DEPLOY_STATE
try {
  $env:READER_DEPLOY_STATE = Join-Path $PWD '.deployment-export-check'
  ./deploy/deploy.ps1 restore --input /transfer/initial.tar.age --mode rebuild
  ./deploy/deploy.ps1 preflight --offline
} finally {
  $env:READER_DEPLOY_STATE = $savedDeployState
}
```

Expected: restore and offline preflight succeed without database access. This check
also confirms the passphrase/identity can open the archive. The check directory
contains another private copy of your keys; protect it like the original and never
start its stack alongside the original. Use a new empty check directory each time.

## 5. Validate and deploy indexes

```bash
bash deploy/deploy.sh preflight --before-indexes
bash deploy/deploy.sh indexes
bash deploy/deploy.sh preflight
```

```powershell
./deploy/deploy.ps1 preflight --before-indexes
./deploy/deploy.ps1 indexes
./deploy/deploy.ps1 preflight
```

`--offline` checks local PKI/state only. Normal preflight checks MongoDB replica-set
capability, decryptability of existing credentials, duplicates, required unique
indexes, and HTTPS connectivity/trust to Rails. It does not mutate cards.

The index command invokes the repository's existing `reader-indexes.cjs` explicitly.
It never runs automatically during API startup and never deletes duplicate data.
Deploy the unique `cards.uid` index through the existing Rails card workflow first;
this tool checks it but does not take ownership of that Rails index. Resolve any
duplicate names, fingerprints, UIDs, or session endings before retrying.

## 6. Provision each reader once

Edit the protected reader JSON: unique name, one of `door`, `garagedoor`, `test`,
`latch`, `tool`, existing tool ObjectId for a Tool reader (otherwise `null`), location,
board (`waveshare`, `olimex`, `qtpy`), private address, management hostname, and
explicit `production: false` for bench work. QT Py additionally needs `wifiSsid`
and `wifiPsk`; both are optional for Ethernet boards. These inputs are private.

```bash
bash deploy/deploy.sh add-reader --reader-file /input/reader-01.json
bash deploy/deploy.sh register-readers
```

```powershell
./deploy/deploy.ps1 add-reader --reader-file /input/reader-01.json
./deploy/deploy.ps1 register-readers
```

Record the printed ObjectId. Each reader gets a unique private key, certificate,
fingerprint, web password, and immutable device ID. The certificate CN is that ID.
Enrollment is initially disabled. Repeating `add-reader` with an existing name or
hostname fails; use `render` to recover the existing header. Registration is
idempotent for unchanged records and refuses to overwrite live configuration changes.

Each later reader issuance creates its own 20-year issuer, appended to the trust
and CRL bundles. This prevents a new reader's certificate from outliving its CA.
The server CA/API/broker certificates retain their original expiration. Recreate
HAProxy and Mosquitto after adding a reader so new trust and ACL files take effect.

## 7. Validate configuration and start the stack

From the repository root, these Docker commands are identical in both shells:

```text
docker compose --env-file .deployment/compose.env config --quiet
docker compose --env-file .deployment/compose.env run --rm --no-deps haproxy haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg
docker compose --env-file .deployment/compose.env up -d --build --wait
docker compose --env-file .deployment/compose.env ps
docker compose --env-file .deployment/compose.env logs --tail 100 api haproxy mosquitto
```

Expected: HAProxy reports valid configuration; all three services become healthy.
API health includes a local authenticated HTTP check and a MongoDB ping. Broker
health is local TCP liveness; the next step checks TLS and credentials. Logs omit
secret values and request bodies. Do not print `state.json`, private handoffs, or
generated headers into tickets or CI output.

For a custom state directory, set **both** `READER_DEPLOY_STATE` for the wrapper
and `DEPLOY_STATE` for Compose to its absolute host path. Pass that directory's
`compose.env` to Compose. Paths passed to the tool itself are container paths:
`/input`, `/transfer`, `/state`.
Keep all state, input and transfer directories outside `src`, `scripts` and `deploy`;
those directories contain the allowlisted Docker build inputs. The default private
directories and other top-level state directories are excluded from that context.

## 8. Verify service and reservation integration

```bash
bash deploy/deploy.sh verify --reader workshop-reader-01 --skip-management
```

```powershell
./deploy/deploy.ps1 verify --reader workshop-reader-01 --skip-management
```

This checks that a client certificate is required, forged identity headers are
overwritten, the authenticated device ID matches, legacy API routes are blocked,
and all three MQTT identities can connect over TLS. For a Tool reader it also reads
reservations and submits `{capable:true,operations:[]}` through the API to Rails.
That request advertises participation, so register all participating readers before
enabling automatic reservation abandonment. It does not claim or release a booking.

Repeat with a **Tool** reader before declaring reservations ready. A test/door
reader cannot validate the Tool-only synchronization contract. After firmware is
running, omit `--skip-management` to verify its actual web login and HTTPS route.
The MQTT certificate test connects with the reader's client ID and can briefly
disconnect an already-connected copy; run verification during commissioning or
maintenance. The production verifier does not publish synthetic activity or
invalidation events. Full allow/deny ACL probes run only in disposable CI.

## 9. Build firmware from preserved credentials

On the Windows firmware workstation, clone the companion reader repository. Run
its setup script, then copy the selected generated header:

```powershell
Set-Location ../makerspace-reader-esp32
./scripts/setup.ps1
Copy-Item ../ts-data-api/.deployment/readers/<DEVICE_ID>/secrets.h MakerspaceReader/secrets.h
# Waveshare S3-ETH, default 16 MB / OPI PSRAM
./scripts/build.ps1 -Reservations 1
# Olimex ESP32-PoE, WROOM 4 MB / no PSRAM
./scripts/build.ps1 -Reservations 1 -Fqbn 'esp32:esp32:esp32-poe:FlashSize=4M,PartitionScheme=custom,DebugLevel=info'
# Adafruit QT Py S3 N4R2, 4 MB / QSPI PSRAM (requires Wi-Fi)
./scripts/build.ps1 -Reservations 1 -Fqbn 'esp32:esp32:adafruit_qtpy_esp32s3_n4r2:PSRAM=enabled,PartitionScheme=default,USBMode=hwcdc,DebugLevel=info'
```

Run only the build command matching that reader. The supported firmware workflow
uses PowerShell; a Linux deployment host can securely transfer the selected header
to that workstation. The generated header supplies API/MQTT origins, device ID,
server trust, client certificate/key, management login, and bench/production flag.
Reservations are enabled by the build's global `-Reservations 1`, not a local macro.
Neither MongoDB credentials nor any server/master secret belongs in firmware.

For automatic cache-key generation, leave `CACHE_KEY_HEX` undefined. An optional
`cacheKeyHex` in the reader JSON supplies a deliberate compiled override; it is
included in encrypted exports. Never remove/change an existing compiled override
during a rebuild. Never reset nonce counters while reusing their encryption key.

## 10. Bench and production commissioning

Start with `production: false` and a dummy relay load. Use the staged partition
table on the **first** flash. Verify time/DNS, both TLS endpoints, management
authentication, card snapshots, supervised enrollment, audit replay, relay behavior,
and reservation attendance. Enable enrollment only for the supervised card setup,
then disable it. Unknown cards remain a Rails assignment task.

Install the public server CA on authorized management workstations and verify
`https://<reader>.readers.example.org:8443/config` and `/update`. HAProxy preserves
Host/Referer and firmware authentication. Management has a separate 5 MiB request
ceiling and five-minute timeouts; the firmware enforces its own image/slot bounds.
Only signed application images belong in production OTA, never merged factory or
filesystem images.

Stock Arduino builds intentionally fail production admission. Before setting a
reader's canonical `production` value to true and running `render`, use the reader
repository's separately secured ESP-IDF/Arduino core workflow, secure boot v2,
flash encryption, NVS encryption, signing keys, and board-specific commissioning.
This package does not generate hardware eFuses or automate that toolchain. Keep
external firmware-signing keys in the organization's own recovery system; they are
not TLS keys and are not implicitly included in this archive.

Follow the companion README and `docs/COMMISSIONING.md` for physical verification.
Changing canonical configuration is an explicit maintenance edit to the protected
state, followed by validation/render; it must not change the reader ID or private
key. Keep a recovery export before such edits. Final hardware acceptance remains
separate from successful compilation and container tests.

## 11. Routine rebuilds, new readers, and revocation

Before updates, export state. Preserve MongoDB, `.deployment`, broker storage,
reader NVS, and LittleFS. Then:

```bash
bash deploy/deploy.sh render
docker compose --env-file .deployment/compose.env up -d --build --force-recreate --wait
```

```powershell
./deploy/deploy.ps1 render
docker compose --env-file .deployment/compose.env up -d --build --force-recreate --wait
```

Recreate services after rendering because file-backed bind mounts can retain the
old inode after an atomic file replacement. Render never replaces key material.
Recompile firmware from its existing header when required; use OTA/application-only
updates on commissioned devices so NVS, counters, caches, and journals remain intact.

To revoke a reader:

```text
# Use the matching Bash/PowerShell wrapper
revoke-reader --reader <NAME_OR_ID>
docker compose --env-file .deployment/compose.env up -d --force-recreate haproxy mosquitto
```

The command disables its Mongo identity and increments reservation coverage
revision, removes its ACL/management entries, and revokes the certificate in its
issuer's CRL. Recreating the services closes existing TLS/MQTT sessions. A disabled
API identity alone does not revoke an existing MQTT session. CRLs last through
their issuer's expiration and are regenerated on each explicit revocation.
The command is retryable if interrupted after the database disable.

Do not run `init` to rotate an encryption key. Card-key rotation requires a separate
decrypt/re-encrypt migration. A lost key cannot be recovered from physical cards.
Certificate renewal/replacement must preserve the reader ObjectId, update its
registered fingerprint deliberately, revoke its previous certificate, and deliver
the new client key/certificate via a controlled firmware update. The current CLI
automates first issuance and revocation, not that coordinated renewal operation.

Before the server CA expires, distribute a trust bundle containing both the old
and new server CA to all readers and management workstations, then change server
leaf certificates, verify all clients, and retire old trust only after migration.
Do not issue a new leaf beyond its issuer's expiration. This is a planned trust
migration, not a routine render or rebuild.

## 12. Back up database state with keys

Keys alone do not contain the card records, assigned member/tool identities,
encrypted `nfc_card_credentials`, pending enrollments, reservation participation,
or audit records. Retain the **whole application database** consistently.

For an Atlas managed snapshot, record its exact backup ID/timestamp:

```text
export --output /transfer/with-snapshot-reference.tar.age --snapshot <ATLAS_SNAPSHOT_ID>
```

That embeds the reference, not the remote data. Restore the snapshot through Atlas
to a separate target deployment before retesting. Follow Atlas backup permissions
and consistency requirements.

For a portable BSON archive, stop **all writers** to this database: API, Rails web
workers/jobs, and any other integrations. `--writers-paused` is your assertion that
this has been done; the tool cannot freeze external Rails jobs. Keep writers paused
through the export:

```bash
docker compose --env-file .deployment/compose.env stop api
# Stop Rails/jobs/other writers through their own deployment controls.
bash deploy/deploy.sh backup-db --output /transfer/database.archive --writers-paused
bash deploy/deploy.sh export --output /transfer/full-recovery.tar.age --database-archive /transfer/database.archive
# Resume external writers, then:
docker compose --env-file .deployment/compose.env start api
```

```powershell
docker compose --env-file .deployment/compose.env stop api
# Stop Rails/jobs/other writers through their own deployment controls.
./deploy/deploy.ps1 backup-db --output /transfer/database.archive --writers-paused
./deploy/deploy.ps1 export --output /transfer/full-recovery.tar.age --database-archive /transfer/database.archive
docker compose --env-file .deployment/compose.env start api
```

The database archive and metadata sidecar are **unencrypted staging files** in the
protected transfer directory. After verifying the encrypted backup, remove those
staging files through your normal secure-data handling process. Never commit them.
The encrypted archive includes a hash-checked snapshot and original database name.
Exports contain keys/configuration only unless an archive/reference is supplied.
After a restore, an old bundled dump is not silently reused for the next export:
take a fresh backup and pass `--database-archive` again.
No oplog/namespace-remapping shortcuts are used: a database-scoped dump is consistent
only while writers are paused. USTAR limits each archive member to just under 8 GiB;
use a managed snapshot reference for larger database archives.

## 13. Restore a server without reinitializing readers/cards

Use an **empty** state directory and the matching code revision/image pins. Put the
encrypted archive in `deployment-transfer`. For age recipient encryption, put the
private age identity in the protected input directory and append
`--identity /input/recovery-identity.txt`. Passphrase exports prompt in the terminal.

```bash
export READER_DEPLOY_STATE="$PWD/.deployment-restored"
export DEPLOY_STATE="$READER_DEPLOY_STATE"
bash deploy/deploy.sh restore --input /transfer/full-recovery.tar.age --mode rebuild
bash deploy/deploy.sh render
bash deploy/deploy.sh preflight
docker compose --env-file .deployment-restored/compose.env up -d --build --wait
bash deploy/deploy.sh verify --reader <BENCH_TOOL_READER>
```

```powershell
$env:READER_DEPLOY_STATE = Join-Path $PWD '.deployment-restored'
$env:DEPLOY_STATE = $env:READER_DEPLOY_STATE
./deploy/deploy.ps1 restore --input /transfer/full-recovery.tar.age --mode rebuild
./deploy/deploy.ps1 render
./deploy/deploy.ps1 preflight
docker compose --env-file .deployment-restored/compose.env up -d --build --wait
./deploy/deploy.ps1 verify --reader <BENCH_TOOL_READER>
```

Stop the original stack before taking over its IPs, DNS, database, and reader traffic.
Rebuild mode reconnects the original database; it does not overwrite it with an old
snapshot. Production database disaster recovery remains a deliberate managed restore.
Do not run `register-readers` to overwrite changes made since initial registration.
Rebuild firmware using the restored `readers/<DEVICE_ID>/secrets.h` and the board
command in step 9; keep the same credentials and use application-only updates on
commissioned devices. Finish by taking a fresh export and recording the database
snapshot reference and commissioning results.

Restore validates age authentication, archive members/hashes, mandatory secrets,
key/certificate pairs, identities, and validity intervals before installing state.
Wrong passphrases/keys, damaged archives, missing required keys, or nonempty targets
fail. No fallback key generation occurs. Invalid archives remain staged until fully
validated and are removed on failure.

## 14. Restore into an isolated retest environment

Prepare a separate MongoDB database and a compatible **test Rails instance using
that same database**. Disable external payments/email/production integrations on
the cloned Rails deployment through its normal test configuration.

Copy the deployment JSON to `deployment-input/test-deployment.json`. Keep API/MQTT
hostnames (including service MQTT), management suffix, API port, and reader MQTT
port unchanged. Change the
Compose project name, database name, Rails origin, bind addresses, and management
CIDRs. Put the test URI in `deployment-input/test-mongodb-uri.txt`.

Use isolated DNS/VLAN routing so the existing compiled names resolve only to this
test stack. Do not attach the bench reader to both live and test brokers. Reserve
private management addresses appropriately on the test network; update its private
inventory mapping if the same physical reader moves to a different address.

```bash
export READER_DEPLOY_STATE="$PWD/.deployment-test"
export DEPLOY_STATE="$READER_DEPLOY_STATE"
bash deploy/deploy.sh restore --input /transfer/full-recovery.tar.age --mode isolated-test --config /input/test-deployment.json --mongo-uri-file /input/test-mongodb-uri.txt
bash deploy/deploy.sh restore-db
bash deploy/deploy.sh render
bash deploy/deploy.sh preflight
docker compose --env-file .deployment-test/compose.env up -d --build --wait
bash deploy/deploy.sh verify --reader <BENCH_TOOL_READER>
```

```powershell
$env:READER_DEPLOY_STATE = Join-Path $PWD '.deployment-test'
$env:DEPLOY_STATE = $env:READER_DEPLOY_STATE
./deploy/deploy.ps1 restore --input /transfer/full-recovery.tar.age --mode isolated-test --config /input/test-deployment.json --mongo-uri-file /input/test-mongodb-uri.txt
./deploy/deploy.ps1 restore-db
./deploy/deploy.ps1 render
./deploy/deploy.ps1 preflight
docker compose --env-file .deployment-test/compose.env up -d --build --wait
./deploy/deploy.ps1 verify --reader <BENCH_TOOL_READER>
```

Append `--additional-ca-file /input/test-rails-ca.pem` to restore if needed. The
isolated restore rewrites runtime connection files before they can be started.
It rejects the original database name even on another cluster, original Rails URL,
original bind addresses, and unchanged management CIDRs. It cannot prove DNS aliases
or infrastructure are isolated; verify routing before connecting an initialized
reader. No broker bridge or production MQTT connection is created.

`restore-db` restores only a bundled, verified, write-quiesced archive, maps the
original database namespace to the chosen test name, refuses nonempty targets,
and does not use `--drop`. For Atlas snapshot references, restore via Atlas instead
of this command. On failure, inspect the partially restored **test** database and
choose another empty test target; no automatic destructive cleanup runs.

Use the same enrolled card and reader against the clone with a dummy relay. Confirm
matching device/card IDs, successful credential lookup and actual RF authentication,
replay behavior, and reservation synchronization. Existing pending enrollment data
must remain intact. Preserve reader NVS and LittleFS throughout: cache keys, nonce
counters, FirstScan, journals, and queued events reside there. The server archive
cannot reconstruct a generated on-device cache key or safely reset its counters.
Never restore old device counters to a device that has advanced them.

## Troubleshooting and validation status

See [VALIDATION.md](VALIDATION.md) for executed checks and outstanding acceptance.

| Failure | Action |
| --- | --- |
| Empty-state/lock error | Use restore/render for rebuilds. Confirm no operation runs before removing a stale `.lock`. |
| Incomplete issuance marker | Preserve evidence and recover the last archive; do not silently issue a different identity. |
| Card credentials cannot decrypt | Recover the original card-encryption key and matching database snapshot. |
| TLS failure | Check DNS/SAN, device clock/NTP, CA bundle, certificate dates, fingerprint and CRL; never disable verification. |
| New reader rejected | Register its exact fingerprint and recreate gateway/broker after rendering. |
| API unhealthy | Check Atlas allowlist, replica-set URI, account permissions and database name. |
| Reservations unavailable | Deploy the compatible Rails endpoint, matching secret, CA trust and reachability. |
| Management 403 | Verify the actual trusted source network, including Docker Desktop/VPN NAT. |
| Configuration changed on live reader | Preserve the live Mongo record; reconcile inventory deliberately rather than overwrite it. |
| Firmware denies production admission | Use the secured core/signing/encryption workflow; a macro alone is insufficient. |

Automated tests use disposable credentials/databases. `npm run test:deployment`
checks PKI, archive corruption, deterministic rendering, database key compatibility,
and consistent isolated restoration (OpenSSL, age and MongoDB tools required).
`RUN_DEPLOY_CONTAINER_TESTS=1 node deploy/test/containers.cjs` creates randomly named
disposable containers to exercise actual Compose, HAProxy mTLS/header filtering,
Mosquitto ACLs, mocked Rails handoff, and management uploads; it removes only those
test containers/volumes afterward. Test state remains in ignored `.cache` for local
diagnosis and must not be uploaded as an artifact.

Physical NFC, relay, NVS power-loss recovery, secured production firmware and OTA
acceptance are operator commissioning tasks, not claims made by these tests.

References: [Docker secrets](https://docs.docker.com/compose/how-tos/use-secrets/),
[HAProxy 3.2](https://docs.haproxy.org/3.2/configuration.html),
[Mosquitto](https://mosquitto.org/man/mosquitto-conf-5.html),
[OpenSSL explicit dates](https://docs.openssl.org/3.0/man1/openssl-ca/),
[age](https://github.com/FiloSottile/age),
[MongoDB consistent backups](https://www.mongodb.com/docs/manual/tutorial/backup-and-restore-tools/).
