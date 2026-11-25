"use strict";
/*
  Where the bus ticket photos are kept.

  A photo is about 150-400 KB. They are NOT stored inside km.db, because km.db is copied to MongoDB every
  few seconds (see start.js) and photos would make that copy too big.
  With MONGODB_URI set, each photo is one small document in the collection "km_ticket_photos" (same database
  as the saved copy of km.db). Without it, photos are written to the folder data/ticket_photos
  (kept only until the next restart on a host with no disk).
*/
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DIR = path.join(DATA_DIR, "ticket_photos");
const URI = process.env.MONGODB_URI || "";
let col = null;

async function open() {
  if (col) return col;
  const { MongoClient } = require("mongodb");
  const client = new MongoClient(URI, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  col = (process.env.MONGODB_DB ? client.db(process.env.MONGODB_DB) : client.db()).collection("km_ticket_photos");
  return col;
}
const key = (id) => String(Number(id));

async function save(id, buf) {
  if (URI) {
    const { Binary } = require("mongodb");
    await (await open()).replaceOne({ _id: key(id) }, { _id: key(id), data: new Binary(buf), bytes: buf.length, savedAt: new Date() }, { upsert: true });
    return;
  }
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, key(id) + ".jpg"), buf);
}
async function load(id) {
  if (URI) {
    const d = await (await open()).findOne({ _id: key(id) });
    if (!d || !d.data) return null;
    const b = d.data.buffer;
    return Buffer.from(b.subarray(0, d.data.position == null ? b.length : d.data.position));
  }
  try { return fs.readFileSync(path.join(DIR, key(id) + ".jpg")); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
}
async function remove(id) {
  try {
    if (URI) await (await open()).deleteOne({ _id: key(id) });
    else fs.rmSync(path.join(DIR, key(id) + ".jpg"), { force: true });
  } catch (e) { console.error("Could not delete a ticket photo:", e.message); }
}

module.exports = { save, load, remove };
