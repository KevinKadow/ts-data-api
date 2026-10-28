import { connect } from "mqtt";
import { dataSources } from "./mdb";
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
  const publish = () =>
    client.connected &&
    client.publish("readers/all/invalidate", '{"refresh":true}', {
      qos: 1,
      retain: false,
    });
  client.on("connect", publish);
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
                ],
              },
            },
          },
        ]);
        try {
          for await (const change of stream) {
            if (change) publish();
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
