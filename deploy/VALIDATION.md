# Deployment package validation

Recorded 2026-11-12. All credentials and databases used below were disposable.
No live service was deployed and no reader was flashed or card initialized.

## Software checks completed

- TypeScript build passed.
- API disposable MongoDB suite: 26 suites, 111 tests passed. Use
  `node scripts/test-disposable.cjs`, not standalone Jest without its database.
- Deployment suite: 15 tests passed, with no skips. This includes actual OpenSSL
  issuance, SAN/purpose/key checks, calendar validity beyond 2038 and near expiry,
  revocation, unchanged rendering, authenticated age recipient encryption,
  tampering/wrong-identity/incomplete-state rejection, MongoDB registration and
  index checks, and real mongodump/mongorestore into a distinct empty database.
- Restored card credential ciphertext, card IDs, reader IDs, and the master key
  matched their originals. This is database-level recovery, not RF-card acceptance.
- Standalone Docker Compose CLI accepted generated configuration. It did not
  start containers: this Windows host has no Docker engine.
- PowerShell parser, Bash syntax, Prettier, and Git whitespace checks passed.

Local software tests ran on Node 24.22.1, OpenSSL 3.5.7, and MongoDB Database Tools
100.13.0. The delivered images pin Node 22.23.5, HAProxy 3.2.26, and Mosquitto 2.0.22
by version and digest. The included CI workflow runs the tools and Compose stack
on Linux, but has not been executed as part of this local work.

## Generated firmware

Test-only generated headers were compiled in an isolated companion checkout using
revision `22fe6cbddfe57b174dd2ce731c878c09ac05042d`, the pinned Arduino ESP32 3.3.12
setup, and its existing staged build scripts.

| Board | Reservations | Application bytes | OTA headroom | Result |
| --- | --- | --- | --- | --- |
| Waveshare S3-ETH, 16 MB | 1 | 1,564,736 | 62.69% | Passed |
| Olimex ESP32-PoE, 4 MB | 1 | 1,485,536 | 12.82% | Passed |
| QT Py S3 N4R2, 4 MB | 1 | 1,415,152 | 16.95% | Passed |
| Waveshare S3-ETH, 16 MB | 0 | 1,509,520 | 64.01% | Passed |
| Olimex ESP32-PoE, 4 MB | 0 | 1,433,808 | 15.85% | Passed |
| QT Py S3 N4R2, 4 MB | 0 | 1,365,088 | 19.89% | Passed |

All six builds passed partition validation and the 10% OTA-headroom gate.
Reservation-disabled builds also passed symbol exclusion; QT Py passed its
Wi-Fi-only symbol checks. Serial LTO warnings were informational.

## Acceptance still required

- Run the included container integration job or
  `RUN_DEPLOY_CONTAINER_TESTS=1 node deploy/test/containers.cjs` on a Docker host.
  It exercises real HAProxy and Mosquitto, TLS identity/header handling, ACLs,
  a mocked Rails handoff, and management forwarding.
- Run the Bash and PowerShell deployment wrappers on their actual Docker hosts,
  including interactive passphrase export, wrong-passphrase rejection, and restore.
  Automated recovery tests used age recipient keys rather than terminal prompts.
- Verify the actual compatible Rails reservation service and its MQTT integration.
- Complete browser login, CSRF writes, signed OTA, network reconnect, physical NFC,
  dummy relay, replay/power-loss, and secured-production admission checks.
- Enroll a disposable physical card, export the keys and consistent database, then
  prove that the same reader/card works in isolation without re-enrollment while
  retaining the reader's NVS and LittleFS.

The companion commissioning/wiki changes are held locally; no wiki was published.
