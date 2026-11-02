import {
  boundedText,
  checkoutUntil,
  effectiveCard,
  validUid,
} from "../reader-policy";
import { registerReservationRoutes } from "../reader-reservations";
import * as h3 from "h3";
import {
  timingSafeEqual,
  createHash,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { ObjectId, Double, Int32, ClientSession } from "mongodb";
import { dataSources } from "../mdb";

function fail(status: number, message: string): never {
  throw h3.createError({ statusCode: status, message });
}
function db() {
  const source = process.env.READER_DATA_SOURCE;
  const name = process.env.READER_DATABASE;
  if (!source || !name || !dataSources[source])
    fail(503, "Reader database is not configured");
  return dataSources[source].db(name, { readPreference: "primary" });
}
function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export async function authenticateReader(event: h3.H3Event) {
  // This secret is held only by the TLS proxy and server, never by readers.
  const secret = process.env.READER_PROXY_SECRET;
  if (
    !secret ||
    !equal(h3.getHeader(event, "x-reader-proxy-secret") || "", secret)
  )
    fail(401, "Verified reader proxy required");
  const fingerprint = h3.getHeader(event, "x-reader-certificate");
  if (!fingerprint || !/^[a-fA-F0-9:]{64,95}$/.test(fingerprint))
    fail(401, "Reader certificate required");
  const normalized = fingerprint.replace(/:/g, "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) fail(401, "Invalid fingerprint");
  const reader = await db().collection("nfc_readers").findOne({
    certificateFingerprint: normalized,
    enabled: true,
  });
  if (!reader) fail(403, "Reader disabled or unknown");
  event.context.reader = reader;
}
function key() {
  const value = Buffer.from(
    process.env.READER_KEY_ENCRYPTION_KEY || "",
    "base64",
  );
  if (value.length !== 32) fail(503, "Credential encryption is not configured");
  return value;
}
function encrypt(value: object) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}
function decrypt(value: any): any {
  const cipher = createDecipheriv(
    "aes-256-gcm",
    key(),
    Buffer.from(value.iv, "base64"),
  );
  cipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return JSON.parse(
    Buffer.concat([
      cipher.update(Buffer.from(value.ciphertext, "base64")),
      cipher.final(),
    ]).toString(),
  );
}
async function body(event: h3.H3Event) {
  const raw = await h3.readRawBody(event);
  if (!raw || Buffer.byteLength(raw) > 16384) fail(413, "Invalid request size");
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return fail(400, "Object body required");
    return value;
  } catch {
    return fail(400, "Invalid JSON");
  }
}
function uid(value: unknown): string {
  if (!validUid(value)) fail(422, "Invalid UID");
  return value;
}
async function cardFor(value: unknown, session?: ClientSession) {
  const cards = await db()
    .collection("cards")
    .find({ uid: uid(value) }, { session })
    .limit(2)
    .toArray();
  if (cards.length > 1) fail(409, "Ambiguous card");
  return cards[0];
}
function config(reader: any) {
  return {
    id: reader._id.toString(),
    name: reader.name,
    role: reader.role,
    toolId: reader.toolId?.toString() || null,
    enrollmentEnabled: !!reader.enrollmentEnabled,
    where: reader.where || "doorboto32",
    serverTime: Date.now(),
  };
}
export const readerRouter = h3.createRouter();
registerReservationRoutes(readerRouter, db);
readerRouter.get(
  "/reader/v1/config",
  h3.defineEventHandler((e) => config(e.context.reader)),
);
readerRouter.post(
  "/reader/v1/config",
  h3.defineEventHandler(async (e) => {
    const b = await body(e);
    if (
      typeof b.name !== "string" ||
      !/^[A-Za-z0-9_-]{1,48}$/.test(b.name || "") ||
      !["door", "garagedoor", "test", "latch", "tool"].includes(b.role) ||
      typeof b.enrollmentEnabled !== "boolean"
    )
      fail(422, "Invalid configuration");
    const toolId =
      b.role === "tool" && ObjectId.isValid(b.toolId || "")
        ? new ObjectId(b.toolId)
        : null;
    if (
      b.role === "tool" &&
      (!toolId || !(await db().collection("tools").findOne({ _id: toolId })))
    )
      fail(422, "A valid tool is required");
    if (
      await db()
        .collection("nfc_readers")
        .findOne({ name: b.name, _id: { $ne: e.context.reader._id } })
    )
      fail(409, "Reader name already exists");
    try {
      await db()
        .collection("nfc_readers")
        .updateOne(
          { _id: e.context.reader._id },
          {
            $set: {
              name: b.name,
              role: b.role,
              toolId,
              enrollmentEnabled: b.enrollmentEnabled,
            },
            $addToSet: { previousNames: e.context.reader.name,
              ...(e.context.reader.toolId ? {previousToolIds:e.context.reader.toolId.toString()} : {}) },
            ...(e.context.reader.role!==b.role || String(e.context.reader.toolId || '')!==String(toolId || '')
              ? {$inc:{reservationCoverageRevision:1}} : {}),
          },
        );
    } catch (err: any) {
      if (err.code === 11000) fail(409, "Reader name already exists");
      throw err;
    }
    return config({
      ...e.context.reader,
      name: b.name,
      role: b.role,
      toolId,
      enrollmentEnabled: b.enrollmentEnabled,
    });
  }),
);
async function readerScope(reader: any) {
  const tool = reader.toolId ? await db().collection("tools").findOne({_id:reader.toolId}) : null;
  return {...reader, shopId: tool?.shop_id?.toString()};
}
async function toolStatus(reader: any) {
  const tool = reader.toolId ? await db().collection("tools").findOne({_id:reader.toolId}) : null;
  const shop = tool ? await db().collection("shops").findOne({_id:tool.shop_id}) : null;
  return { enabled: !!tool && !!shop && !tool.disabled && !shop.disabled,
    name: boundedText(tool?.name,96), shopId: shop?._id.toString() || "", shopName: boundedText(shop?.name,96),
    toolOutOfService: !!tool?.out_of_service, shopOutOfService: !!shop?.out_of_service };
}
async function cardView(c: any, reader?: any) {
  const member = await db().collection("members").findOne({ _id: c.member_id });
  const credential = await db().collection("nfc_card_credentials").findOne({
    _id: c._id,
    uid: c.uid,
    memberId: c.member_id,
    state: "active",
  });
  const material = credential ? decrypt(credential.sealed) : null;
  return {
    _id: c._id.toString(),
    uid: c.uid,
    holder: boundedText(c.holder, 256),
    firstName: boundedText(member?.firstname, 64),
    lastInitial: boundedText(Array.from(String(member?.lastname || ""))[0] || "", 4),
    managesTool: !!reader && (member?.role === "admin" || member?.role === "board_member" ||
      (member?.role === "resource_manager" && (member.resource_manager_shop_ids || []).map(String).includes(reader.shopId))),
    ...effectiveCard(c, member),
    memberId: c.member_id?.toString(),
    credential: material
      ? {
          keyA: material.keyA,
          digest: material.digest,
          version: material.version,
        }
      : null,
  };
}
async function currentGrant(reader: any, memberId: string | undefined) {
 if (reader.role !== "tool" || !memberId) return null;
 const tool = await toolStatus(reader); if (!tool.enabled) return null;
 let best: any = null;
 for await (const row of db().collection("tool_checkouts").find({tool_id:reader.toolId,member_id:new ObjectId(memberId),revoked_at:null,superseded_by_id:null})) {
   const until=checkoutUntil(row.expires_on);
   if (until>Date.now() && (!best || until>best.until)) best={memberId,checkoutId:row._id.toString(),until};
 }
 return best;
}
readerRouter.post(
  "/reader/v1/cards/lookup",
  h3.defineEventHandler(async (e) => {
    const c = await cardFor((await body(e)).uid);
    return { grant: await currentGrant(e.context.reader, c?.member_id?.toString()), document: c ? await cardView(c, await readerScope(e.context.reader)) : null, tool: await toolStatus(e.context.reader), serverTime: Date.now() };
  }),
);
async function readerSnapshot(e: h3.H3Event, recent?: string[]) {
    const scope = await readerScope(e.context.reader);
    let grants: any[] = [],
      available = false,
      toolName = "";
    if (e.context.reader.role === "tool") {
      const tool = await db()
        .collection("tools")
        .findOne({ _id: e.context.reader.toolId });
      const shop =
        tool && (await db().collection("shops").findOne({ _id: tool.shop_id }));
      available =
        !!tool &&
        !!shop &&
        !tool.disabled &&
        !shop.disabled &&
        !tool.out_of_service &&
        !shop.out_of_service;
      toolName = boundedText(tool?.name, 96);
      if (tool && shop && !tool.disabled && !shop.disabled) {
        const rows = await db().collection("tool_checkouts").find({
          tool_id: tool!._id,
          revoked_at: null,
          superseded_by_id: null,
        });
        const byMember = new Map<string, any>();
        for await (const row of rows) {
          const until = checkoutUntil(row.expires_on);
          if (until <= Date.now()) continue;
          const id = row.member_id.toString(),
            old = byMember.get(id);
          if (!old || until > old.until)
            byMember.set(id, {
              memberId: id,
              checkoutId: row._id.toString(),
              until,
            });
        }
        grants = [...byMember.values()];

      }
    }
    const allowed = new Set(grants.map(g => g.memberId));
    const now = Date.now();
    const cards: any[] = [];
    const seen = new Set<string>();
    // Iterate instead of materializing the whole collection on the API host.
    for await (const row of db().collection("cards").find({validity:"activeMember", expiry:{$gt:now}})) {
      if (!validUid(row.uid)) continue;
      const card = await cardView(row, scope);
      if (card.validity !== "activeMember" || card.expiry <= now) continue;
      if (scope.role === "tool" && !card.managesTool && !allowed.has(card.memberId)) continue;
      if (recent && !card.managesTool && !recent.includes(card.uid)) continue;
      if (seen.has(card.uid) || await db().collection("cards").countDocuments({uid:card.uid}, {limit:2}) > 1) fail(409, "Duplicate eligible card UID");
      seen.add(card.uid); cards.push(card);
      if (cards.length > (recent ? 128 : 300)) fail(409, "Eligible card cache capacity exceeded");
    }
    const members = new Set(cards.map(c => c.memberId));
    grants = grants.filter(g => members.has(g.memberId));
    if (grants.length > (recent ? 128 : 150)) fail(409, "Checkout cache capacity exceeded");
    return {
      config: config(e.context.reader),
      cards,
      grants,
      tool: { ...(await toolStatus(e.context.reader)), available, name: toolName },
      serverTime: Date.now(),
    };
}
readerRouter.get("/reader/v1/snapshot", h3.defineEventHandler(e => readerSnapshot(e)));
readerRouter.post("/reader/v1/snapshot/recent", h3.defineEventHandler(async e => {
  const input = await body(e);
  if (!Array.isArray(input.uids) || input.uids.length > 128 || input.uids.some((v: unknown) => !validUid(v)) || new Set(input.uids).size !== input.uids.length) fail(422, "Unique UID list required (maximum 128)");
  return readerSnapshot(e, input.uids);
}));
// Fence both card assignment and station configuration inside the transaction.
// A concurrent Rails release/reassignment or station disable conflicts with these writes.
async function enrollmentTransaction<T>(
  e: h3.H3Event,
  value: unknown,
  operation: (card: any, session: ClientSession) => Promise<T>,
): Promise<T> {
  const client = dataSources[process.env.READER_DATA_SOURCE!];
  const session = client.startSession();
  try {
    return (await session.withTransaction(
      async () => {
        const station = await db()
          .collection("nfc_readers")
          .updateOne(
            {
              _id: e.context.reader._id,
              enabled: true,
              enrollmentEnabled: true,
            },
            { $inc: { enrollmentFence: 1 } },
            { session },
          );
        if (!station.matchedCount) fail(403, "Enrollment disabled");
        const c = await cardFor(value, session);
        if (
          !c ||
          !c.member_id ||
          !(await db()
            .collection("members")
            .findOne({ _id: c.member_id }, { session }))
        )
          fail(404, "Assigned card required");
        await db()
          .collection("cards")
          .updateOne(
            { _id: c._id, member_id: c.member_id },
            { $inc: { readerEnrollmentFence: 1 } },
            { session },
          );
        return operation(c, session);
      },
      {
        readPreference: "primary",
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
      },
    ))!;
  } finally {
    await session.endSession();
  }
}
readerRouter.post(
  "/reader/v1/enrollment/begin",
  h3.defineEventHandler(async (e) => {
    const b = await body(e);
    return enrollmentTransaction(e, b.uid, async (c, session) => {
      const existing = await db()
        .collection("nfc_card_credentials")
        .findOne({ _id: c._id }, { session });
      if (existing) {
        if (
          existing.state !== "pending" ||
          existing.uid !== c.uid ||
          !existing.memberId.equals(c.member_id)
        )
          fail(409, "Already enrolled or assignment changed");
        return { enrollmentId: c._id.toString(), ...decrypt(existing.sealed) };
      }
      const credential = randomBytes(32);
      const metadata = Buffer.alloc(16);
      metadata.write("MSP1");
      metadata.writeUInt32BE(1, 4);
      const material = {
        keyA: randomBytes(6).toString("hex"),
        keyB: randomBytes(6).toString("hex"),
        contents: Buffer.concat([credential, metadata]).toString("hex"),
        version: 1,
        digest: createHash("sha256")
          .update(Buffer.from(c.uid, "hex"))
          .update(credential)
          .update(metadata)
          .digest("hex"),
      };
      await db()
        .collection("nfc_card_credentials")
        .insertOne(
          {
            _id: c._id,
            memberId: c.member_id,
            uid: c.uid,
            state: "pending",
            sealed: encrypt(material),
            createdAt: new Date(),
          },
          { session },
        );
      return { enrollmentId: c._id.toString(), ...material };
    });
  }),
);
readerRouter.post(
  "/reader/v1/enrollment/commit",
  h3.defineEventHandler(async (e) => {
    const b = await body(e);
    return enrollmentTransaction(e, b.uid, async (c, session) => {
      if (c._id.toString() !== b.enrollmentId) fail(409, "Assignment changed");
      const row = await db()
        .collection("nfc_card_credentials")
        .findOne(
          { _id: c._id, uid: c.uid, memberId: c.member_id },
          { session },
        );
      if (
        !row ||
        !["pending", "active"].includes(row.state) ||
        !equal(String(b.digest || ""), decrypt(row.sealed).digest)
      )
        fail(409, "Readback verification failed");
      await db()
        .collection("nfc_card_credentials")
        .updateOne(
          { _id: c._id, memberId: c.member_id },
          {
            $set: {
              state: "active",
              enrolledAt: row.enrolledAt || new Date(),
              enrolledBy: row.enrolledBy || e.context.reader._id,
            },
          },
          { session },
        );
      return { acknowledged: true };
    });
  }),
);
readerRouter.post(
  "/reader/v1/events",
  h3.defineEventHandler(async (e) => {
    const b = await body(e),
      d = b.document;
    if (
      !["checkins", "checkend", "rejections"].includes(b.collection) ||
      !d ||
      !/^[0-9a-f]{24}$/i.test(d._id || "") ||
      !Number.isSafeInteger(d.time) ||
      d.time < 0 ||
      d.time > 8640000000000000 ||
      typeof d.validity !== "string" ||
      d.validity.length > 64 ||
      !(
        d.holder === null ||
        (typeof d.holder === "string" && d.holder.length <= 256)
      )
    )
      fail(422, "Invalid event");
    uid(d.uid);
    if (
      ![
        e.context.reader.name,
        ...(e.context.reader.previousNames || []),
      ].includes(d.reader) ||
      d.where !== (e.context.reader.where || "doorboto32")
    )
      fail(403, "Reader identity mismatch");
    const extra: Record<string, any> = {};
    for (const key of ["memberId","toolId","shopId","toolName","shopName"]) {
      if (d[key] !== undefined) {
        if (typeof d[key] !== "string" || d[key].length > 256) fail(422,"Invalid tool event context");
        extra[key] = d[key];
      }
    }
    if (b.collection === "checkend") {
      if (!/^[0-9a-f]{24}$/i.test(d.checkinId || "") || typeof d.kicked !== "boolean") fail(422,"Invalid checkend");
      extra.checkinId=d.checkinId.toLowerCase(); extra.kicked=d.kicked; extra.kickedBy=null;
      if (d.kicked) {
        const actor=d.kickedBy;
        if (!actor || typeof actor.memberId !== "string" || !/^[0-9a-f]{24}$/i.test(actor.memberId) || typeof actor.holder !== "string" || actor.holder.length>256) fail(422,"Invalid kick actor");
        uid(actor.uid);
        extra.kickedBy={memberId:actor.memberId,uid:actor.uid,holder:actor.holder};
      }
    }
    const document = {
      ...extra,
      _id: new ObjectId(d._id),
      uid: d.uid,
      holder: d.holder,
      validity: d.validity,
      where: d.where,
      reader: d.reader,
      delay: new Int32(0),
      time: new Double(d.time),
      timeOf: d.time ? new Date(d.time) : null,
      timeQuality: d.time ? "trusted" : "unavailable",
      reason: String(d.reason || "").slice(0, 128),
      deviceId: e.context.reader._id,
    };
    const collection = db().collection(b.collection);
    const identity = b.collection === "checkend"
      ? { $or: [{_id:document._id}, {deviceId:document.deviceId, checkinId:extra.checkinId}] }
      : {_id:document._id};
    const extraFields = ["memberId","toolId","shopId","toolName","shopName","checkinId","kicked","kickedBy"];
    const sameEvent = (existing: any) => existing &&
      existing._id.toString() === document._id.toString() &&
      existing.deviceId?.toString() === document.deviceId.toString() &&
      existing.uid === document.uid && Number(existing.time) === d.time &&
      existing.validity === document.validity && existing.holder === document.holder &&
      existing.reason === document.reason && existing.reader === document.reader && existing.where === document.where &&
      extraFields.every(key => JSON.stringify(existing[key]) === JSON.stringify(extra[key]));
    const existing = await collection.findOne(identity);
    if (existing && !sameEvent(existing)) fail(409, "Conflicting event ID or session end");
    if (!existing) {
      try {
        await collection.insertOne(document);
      } catch (error: any) {
        if (error.code === 11000) {
          if (sameEvent(await collection.findOne(identity))) return {acknowledged:true,id:d._id};
          fail(409,"Conflicting event ID or session end");
        }
        throw error;
      }
    }
    return { acknowledged: true, id: d._id };
  }),
);
