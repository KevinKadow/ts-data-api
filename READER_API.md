# Makerspace reader API

“The API” means this **ts-data-api Node service**, extended with /reader/v1 routes. The service uses the official MongoDB Node driver to access Atlas. ESP32 readers do not connect directly to MongoDB and never receive Atlas credentials or a general-purpose API JWT.

## Authentication and deployment boundary

Each reader has an individual TLS client certificate. The TLS gateway validates it against the reader CA, then overwrites x-reader-certificate with the certificate's SHA-256 DER fingerprint and x-reader-proxy-secret with a gateway-held secret. The API looks up an enabled nfc_readers record by fingerprint. Missing configuration or invalid/disabled identity fails closed.

Use [deploy/reader-haproxy.cfg](deploy/reader-haproxy.cfg) as the gateway template. The API process must bind privately and be reachable only by the trusted gateway. Never trust these headers from an Internet-facing direct API connection. Client certificates grant no access to /defaults or /custom routes, which retain their existing JWT authentication. Conversely, an ordinary JWT cannot access /reader routes.

The management browser's compiled-in username/password authenticates to the ESP32 web UI; it is separate from device mTLS and the gateway secret. The firmware checks that its compiled DEVICE_ID matches the immutable reader ObjectId returned by the API.

## Environment variables

| Variable | Required/default | Purpose |
| --- | --- | --- |
| DATA_SOURCES | Existing configuration | Map of names to MongoDB connection URIs; Atlas credentials stay here |
| READER_DATA_SOURCE | Required for reader routes; no default | One DATA_SOURCES key |
| READER_DATABASE | Required; no default | Explicit makerspace database name |
| READER_PROXY_SECRET | Required; no default | Random shared gateway/API secret, never compiled into readers |
| READER_KEY_ENCRYPTION_KEY | Required for credentials; no default | Base64 32-byte AES-256-GCM server key; retain for existing enrolled cards |
| READER_MQTT_URL | Optional; unset disables change-stream publishing | mqtts:// broker URL only |
| READER_MQTT_USERNAME | Optional; broker-specific | Service publisher identity |
| READER_MQTT_PASSWORD | Optional; broker-specific secret | Service publisher password |
| NODE_EXTRA_CA_CERTS | Optional Node setting | Additional private CA PEM for the service's MQTTS connection |
| SERVER_ADDRESS | Existing default 127.0.0.1 | Keep private behind the trusted gateway |
| SERVER_PORT | Existing default 8080 | Internal HTTP listener |

READER_MQTT_URL enables a database change-stream worker. It watches cards, members, tools, shops, tool_checkouts, nfc_card_credentials and nfc_readers, publishing non-retained QoS 1 scoped tool/shop document hints and readers/all/invalidate hints for other authorization changes. It reconnects after errors; missed hints recover through firmware's configurable snapshots (15 minutes by default). Only publish the hint while connected, avoiding an unbounded offline MQTT queue. MongoDB must be Atlas or a replica set for enrollment transactions and change streams.

Keep all credentials in deployment secrets. Rotate certificates by replacing certificateFingerprint on the same reader ObjectId and deploying the new certificate/key; queued event identities remain stable. Changing the server encryption key requires an explicit decrypt/re-encrypt migration, not merely changing the environment value.

## Registration and indexes

First audit for duplicate reader names and certificate fingerprints, then run:

```sh
node scripts/reader-indexes.cjs
```

This is an explicit deployment operation, not an application startup hook or test. It creates unique name and certificateFingerprint indexes in nfc_readers. The existing unique cards.uid index must also be deployed by Rails' card workflow.

Register a document through an administrator-controlled MongoDB session:

```javascript
{
  _id: ObjectId(),                  // copy this value to firmware DEVICE_ID
  name: "workshop-reader-01",       // unique, 1–48 ASCII letters/digits/_/-
  certificateFingerprint: "<64 lowercase SHA-256 hexadecimal digits>",
  enabled: true,
  role: "test",                     // door, garagedoor, test, latch, tool
  enrollmentEnabled: false,
  toolId: null,                     // ObjectId required for role tool
  where: "doorboto32"
}
```

The server adds previousNames during rename for delayed audit replay and enrollmentFence during enrollment transactions. Per-card readerEnrollmentFence is an internal conflict-detection field, not a Rails lifecycle callback or member-status mutation.

## HTTP contract

Send application/json. ObjectIds in request/response JSON are strings. Reader bodies are limited to 16 KiB; enforce the same bound at the gateway before buffering. Responses include Content-Length and Cache-Control: no-store.

| Method/path | Input | Success |
| --- | --- | --- |
| GET /reader/v1/config | None | id, name, role, toolId, enrollmentEnabled, where, serverTime |
| POST /reader/v1/config | name, role, toolId, enrollmentEnabled | Validated configuration; duplicate names return 409 |
| POST /reader/v1/cards/lookup | uid | document or null, serverTime; duplicate UID returns 409 |
| GET /reader/v1/snapshot | None | config, cards, grants, tool, serverTime; capacity/duplicate violation returns 409 |
| POST /reader/v1/enrollment/begin | uid | enrollmentId, keyA, keyB, contents, digest, version |
| POST /reader/v1/enrollment/commit | uid, enrollmentId, digest | acknowledged:true |
| POST /reader/v1/events | collection, document | acknowledged:true, id |

UIDs preserve leading zeroes and must be uppercase hexadecimal of 4, 7 or 10 bytes. Unknown/unassigned cards cannot enroll (404). Invalid input returns 400/413/422, missing identity 401, disabled/unknown device or forbidden enrollment 403, conflicting state 409, unconfigured reader service 503; unavailable MongoDB fails without acknowledging a write.

A card view includes _id, uid, holder, validity, expiry, memberId and credential. Only an active credential matching card ObjectId, UID and member assignment supplies keyA, digest and version; Key B is never returned by ordinary lookup/snapshot. Effective validity checks both card and current member status; effective expiry is the earlier of their expirations.

Snapshots contain at most 300 cards and 150 current grants. Tool grants exclude revoked/superseded/expired checkouts and require enabled tool/shop records; out-of-service flags do not remove grants. Null expires_on is non-expiring; a checkout date expires at the start of the following day in America/New_York, including DST.

Enrollment stores random pending material encrypted with AES-GCM in nfc_card_credentials. Retries reuse that material. Begin/commit transactions fence the station and card against concurrent disable or reassignment. Commit trusts readback attestation from the authorized station; it does not independently prove physical RF communication. A released/reassigned UID must never reuse another card document's credential. Retire orphan credential records only through an explicit operator process after reviewing pending enrollments; no automatic destructive cleanup runs.

## Events and MQTT

collection is restricted to checkins, checkend or rejections. document requires _id (24 hex), uid, holder (string/null), validity, reader, where, time (epoch milliseconds) and optional reason. The service derives BSON ObjectId/Double/Int32/Date fields and the immutable authenticated deviceId. timeOf comes from time; timeQuality is trusted or unavailable. A pre-time rejection uses time=0 and timeOf=null. delay is always Int32(0).

Identical retries acknowledge the same _id; conflicting replays return 409 and do not overwrite the record. Older registered station names remain valid for delayed records. No arbitrary database, collection, filter, update operator or member status is accepted from readers.

The reader publishes successful checkins to activity/checkins as canonical Extended JSON matching the stored document, QoS 1 and retain=false. MQTT consumers deduplicate on _id; replay after a lost PUBACK can duplicate publication. MQTT and Mongo acknowledgments are independent. The API change-stream worker publishes invalidation hints only, not duplicate checkin events.

The supplied cards/update and cards/insert prefix format is accepted by the firmware as a refresh hint. It cannot directly install keys, restore a revoked card or overwrite station-local FirstScan.

## Validation and rollout

```sh
npm ci
npm run build
npm run test:disposable
```

The runner creates a disposable MongoDB replica set and overrides DATA_SOURCES; it does not use a configured Atlas/test database. Tests cover legacy API behavior, device authentication boundaries, pending enrollment recovery and concurrency, reassignment/disable, unique names, tool eligibility/DST, cache bounds and event idempotence. Gateway mTLS, broker ACLs, real Atlas deployment, physical NFC and signed OTA still require commissioning.

Compatible h3/defu/jws security patches and Zod **4.6.7** are included. The Zod migration resolves [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5). Record schemas now specify string keys explicitly and the shared body validator uses Zod 4 error flattening while preserving the HTTP 400 message envelope. Default field-error wording follows Zod 4; custom errors remain unchanged. Non-finite values are rejected by z.number(). MongoDB operators, update pipelines, nested BSON/EJSON values, optional filters/options, ObjectId transforms and environment defaults are covered by compatibility tests.

On 2026-10-28, TypeScript compilation and all **25 suites / 84 tests** passed against disposable MongoDB. Regression tests reject 10,000 invalid elements in a bounded array with one size error, and ensure oversized sets skip child validation. The exact constrained-collection advisory trigger is not present in existing application schemas; upgrading removes the vulnerable dependency without imposing new collection-size contracts. This does not add a general request-size limit to legacy routes. Reader routes retain their separate bounded validation.

npm audit --omit=dev reports **zero vulnerabilities**. The full audit still reports **16 inherited development-only findings** (9 low, 6 high, 1 critical), outside this Zod migration. No environment variables or reader wire contracts changed.

Deploy API/indexes/gateway/broker policy first, then provision bench readers, then the separately secured production firmware. Rails inventory updates describe this companion integration; no Rails/React endpoint or generated client release is changed. The held wiki draft must be reviewed and published with the actual deployment.



## Tool-session contract extension

Deploy this gateway before the session-capable firmware. Cards expose firstName,
lastInitial and managesTool (admin/board or resource_manager assigned to this
reader's shop). Snapshot and lookup responses include tool enabled, shopId,
shopName, toolOutOfService and shopOutOfService. Existing available remains false
on an outage, but valid grants remain present so current sessions can continue.
Tool/shop change-stream messages publish scoped tools/<operation> and
shops/<operation> document hints, without generic stop-all invalidations.

Events additionally accept collection checkend. Tool event context has string
memberId/toolId/shopId/toolName/shopName fields. Checkend requires checkinId,
kicked and, for a kick, kickedBy containing memberId, uid and holder; non-kicks
store kickedBy=null. These fields participate in immutable replay validation.
Unknown reboot ending times use time=0. Tool checkins and checkends publish to
activity/checkins/<SHOP>/<TOOL> and activity/checkends/<SHOP>/<TOOL>, respectively.
Topic segments percent-escape %, /, + and #. Update broker ACLs before rollout.
No environment variables or Rails/React API client changes are required.
