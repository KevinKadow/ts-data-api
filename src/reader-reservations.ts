import * as h3 from "h3";
import { Db, ObjectId } from "mongodb";
import { boundedText } from "./reader-policy";

const error = (statusCode: number, message: string): never => {
  throw h3.createError({ statusCode, message });
};
export function reservationFilter(tool: any, now: number, hours = 4) {
  return {
    status: "approved",
    end_at: { $gt: new Date(now) },
    start_at: { $lte: new Date(now + hours * 3600000) },
    $or: [
      { reservation_scope: "tools", tool_ids: tool._id.toString() },
      { reservation_scope: "shop", shop_id: tool.shop_id },
    ],
  };
}

export function registerReservationRoutes(
  router: ReturnType<typeof h3.createRouter>,
  database: () => Db,
) {
  router.get(
    "/reader/v1/reservations",
    h3.defineEventHandler(async (e) => {
      const db = database(),
        reader = e.context.reader;
      if (reader.role !== "tool" || !reader.toolId)
        error(403, "Tool reader required");
      const tool = await db.collection("tools").findOne({ _id: reader.toolId });
      if (!tool) error(404, "Tool unavailable");
      const shop = await db.collection("shops").findOne({ _id: tool!.shop_id });
      const query = h3.getQuery(e);
      const at = query.at === undefined ? Date.now() : Number(query.at);
      if (!Number.isSafeInteger(at) || Math.abs(Date.now() - at) > 120000)
        error(422, "Invalid snapshot time");
      const hours = query.hours === undefined ? 4 : Number(query.hours);
      const limit = query.limit === undefined ? 32 : Number(query.limit);
      if (![4,8].includes(hours) || ![16,32].includes(limit)) error(422, "Invalid reservation limits");
      const filter: any = reservationFilter(tool, at, hours);
      const future = { ...filter, start_at: { $exists: true } };
      const [group, existing] = await Promise.all([
        db
          .collection("tool_groups")
          .findOne(
            {
              included_tool_ids: tool!._id.toString(),
              reservable: true,
              archived: { $ne: true },
            },
            { projection: { _id: 1 } },
          ),
        db
          .collection("reservations")
          .findOne(future, { projection: { _id: 1 } }),
      ]);
      const reservable = !!(
        tool!.reservable ||
        shop?.reservable ||
        group ||
        existing
      );
      if (query.after !== undefined) {
        const [start, id] = String(query.after).split(":");
        if (!/^\d+$/.test(start) || !/^[a-f0-9]{24}$/.test(id || ""))
          error(422, "Invalid cursor");
        filter.$and = [
          {
            $or: [
              { start_at: { $gt: new Date(Number(start)) } },
              {
                start_at: new Date(Number(start)),
                _id: { $gt: new ObjectId(id) },
              },
            ],
          },
        ];
      }
      const rows = reservable
        ? await db
            .collection("reservations")
            .find(filter, {
              projection: {
                member_id: 1,
                start_at: 1,
                end_at: 1,
                status: 1,
                reader_revision: 1,
                arrived_at: 1,
                reader_monitor_started_at: 1,
                reader_monitors: 1,
              },
            })
            .sort({ start_at: 1, _id: 1 })
            .limit(limit + 1)
            .toArray()
        : [];
      const more = rows.length > limit;
      const page = rows.slice(0, limit);
      const ids = [
        ...new Map(
          page.map((r) => [String(r.member_id), r.member_id]),
        ).values(),
      ];
      const members = await db
        .collection("members")
        .find(
          { _id: { $in: ids } },
          { projection: { firstname: 1, lastname: 1 } },
        )
        .toArray();
      const names = new Map(
        members.map((m) => [
          String(m._id),
          boundedText(
            `${m.firstname || ""} ${Array.from(String(m.lastname || ""))[0] || ""}`.trim(),
            64,
          ),
        ]),
      );
      const last = page[page.length - 1];
      const namesSafe = [shop?.name, tool!.name].every(
        (name) =>
          typeof name === "string" &&
          name.length > 0 &&
          !/[+#\u0000]/.test(name),
      );
      const base = `reservations/${shop?.name}`;
      const hintTopics = namesSafe
        ? [
            base,
            `${base}/UpNext`,
            `${base}/${tool!.name}`,
            `${base}/${tool!.name}/UpNext`,
          ].filter((t) => Buffer.byteLength(t) < 256)
        : [];
      return {
        toolId: String(tool!._id),
        shopId: String(tool!.shop_id),
        reservable,
        serverTime: Date.now(),
        snapshotAt: at,
        hintTopics,
        complete: !more,
        next: more ? `${last.start_at.getTime()}:${last._id}` : null,
        reservations: page.map((r) => ({
          id: String(r._id),
          memberId: String(r.member_id),
          name: names.get(String(r.member_id)) || "Member",
          startAt: r.start_at.getTime(),
          endAt: r.end_at.getTime(),
          status: r.status,
          revision: r.reader_revision || 0,
          arrivedAt: r.arrived_at?.getTime() || 0,
          monitored: !!r.reader_monitors?.[String(reader._id)],
        })),
      };
    }),
  );

  router.post(
    "/reader/v1/reservations/sync",
    h3.defineEventHandler(async (e) => {
      const raw = await h3.readRawBody(e);
      if (!raw || Buffer.byteLength(raw) > 16384)
        error(413, "Invalid request size");
      let body: any;
      try {
        body = JSON.parse(raw!);
      } catch {
        error(400, "Object required");
      }
      if (
        !body ||
        !Array.isArray(body.operations) ||
        body.operations.length > 16 ||
        typeof body.capable !== "boolean"
      )
        error(422, "Invalid synchronization");
      const reader = e.context.reader;
      if (body.capable && reader.role !== "tool")
        error(403, "Tool reader required");
      const origin = process.env.READER_RAILS_URL,
        secret = process.env.READER_RESERVATION_SERVICE_SECRET;
      if (
        !origin ||
        !/^https?:\/\//.test(origin) ||
        !secret ||
        secret.length < 32
      )
        error(503, "Reservation lifecycle unavailable");
      // Capability changes do not silently remove a previously frozen participant.
      await database()
        .collection("nfc_readers")
        .updateOne(
          { _id: reader._id, reservationEnabled: { $ne: body.capable } },
          {
            $set: { reservationEnabled: body.capable },
            $inc: { reservationCoverageRevision: 1 },
          },
        );
      let response: Response;
      try {
        response = await fetch(
          new URL("/api/internal/reader_reservations/sync", origin),
          {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(2500),
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${secret}`,
            },
            body: JSON.stringify({
              deviceId: String(reader._id),
              operations: body.operations,
            }),
          },
        );
      } catch {
        return error(503, "Reservation lifecycle unavailable");
      }
      if (!response.ok)
        error(
          response.status === 409 ? 409 : response.status === 422 ? 422 : 503,
          "Reservation synchronization rejected",
        );
      const result: any = await response.json();
      if (
        !Array.isArray(result.results) ||
        result.results.length !== body.operations.length
      )
        error(502, "Invalid lifecycle response");
      return result;
    }),
  );
}
