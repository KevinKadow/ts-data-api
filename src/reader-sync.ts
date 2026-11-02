import { connect } from "mqtt";
import { dataSources } from "./mdb";
// Coverage bookkeeping must not create a refresh -> checkpoint -> refresh loop.
export function readerReservationBookkeeping(change: any): boolean {
  if(change?.ns?.coll!=="reservations" || change.operationType!=="update") return false;
  const fields=[...Object.keys(change.updateDescription?.updatedFields || {}),...(change.updateDescription?.removedFields || [])];
  return fields.length>0 && fields.every(key=>["reader_monitors","reader_monitor_started_at","reader_state_version",
    "reader_receipts","reader_sync_pending","updated_at"].includes(key.split('.')[0]));
}
// Reconnection is not evidence of revocation. Request verification without
// interrupting current work; actual authorization changes retain invalidation.
export function readerSyncPublication(change?: any) {
  if (!change) return {topic:"readers/all/refresh", payload:'{"refresh":true}'};
  if (["reservations", "tool_groups"].includes(change.ns?.coll))
    return {topic:"readers/all/reservations/refresh", payload:'{"refresh":true}'};
  // Capability heartbeats are not authorization revocations.
  if (change.ns?.coll === "nfc_readers" && change.operationType === "update" &&
      Object.keys(change.updateDescription?.updatedFields || {}).length > 0 &&
      Object.keys(change.updateDescription?.updatedFields || {}).every(k => ["reservationEnabled","reservationCoverageRevision"].includes(k)) &&
      !(change.updateDescription?.removedFields || []).length)
    return {topic:"readers/all/reservations/refresh", payload:'{"refresh":true}'};
  if (["tools","shops"].includes(change.ns?.coll)) {
    return {topic:change.ns.coll+"/"+change.operationType,
      payload:JSON.stringify({document:change.fullDocument ?? change.documentKey ?? {}})};
  }
  return {topic:"readers/all/invalidate", payload:'{"refresh":true}'};
}
export function startReaderSync() {
  const url = process.env.READER_MQTT_URL,
    source = process.env.READER_DATA_SOURCE,
    database = process.env.READER_DATABASE;
  if (!url || !source || !database) return;
  if (!url.startsWith("mqtts://"))
    throw new Error("READER_MQTT_URL must use TLS");
  const client = connect(url, {
    username: process.env.READER_MQTT_USERNAME,
    password: process.env.READER_MQTT_PASSWORD,
    rejectUnauthorized: true,
    reconnectPeriod: 5000,
  });
  const publish = (change?: any) => {
    if(readerReservationBookkeeping(change)) return;
    const event=readerSyncPublication(change);
    if (client.connected) client.publish(event.topic,event.payload,{qos:1,retain:false});
  };
  client.on("connect", () => publish());
  client.on("error", () => console.error("Reader MQTT connection failed"));
  const run = async () => {
    while (true) {
      try {
        const stream = dataSources[source].db(database).watch([
          {
            $match: {
              "ns.coll": {
                $in: [
                  "cards",
                  "members",
                  "tools",
                  "shops",
                  "tool_checkouts",
                  "nfc_card_credentials",
                  "nfc_readers",
                  "reservations",
                  "tool_groups",
                ],
              },
            },
          },
        ], {fullDocument: "updateLookup"});
        try {
          for await (const change of stream) {
            if (change) publish(change);
          }
        } finally {
          await stream.close();
        }
      } catch {
        console.error(
          "Reader change stream interrupted; refreshing on recovery",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
      publish();
    }
  };
  void run();
}
