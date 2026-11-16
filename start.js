"use strict";
/*
  Keeps the KM Tracker data safe across restarts.

  Render's free plan has no disk, so km.db is wiped whenever the app restarts or sleeps.
  This file runs before server.js:
    1. If km.db is missing, it restores the last saved copy from MongoDB (the same database the
       attendance app uses, in its own collection "km_snapshot").
    2. It starts server.js.
    3. Every few seconds, if anything changed, it saves a compressed copy to MongoDB. It also saves once
       more when Render stops the app, so the last few seconds are not lost.
  If the saved copy cannot be read, the app stops instead of starting empty, so good data is never overwritten.
  Without MONGODB_URI it just starts server.js as before (data is kept only until the next restart).
  Optional: MONGODB_DB (database name), KM_SNAPSHOT_SECONDS (default 15).
*/
const fs = require("fs");
const path = require("path");
const os = require("os");
const zlib = require("zlib");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "km.db");
const URI = process.env.MONGODB_URI || "";
const FILE_DIR = process.env.KM_SNAPSHOT_DIR || ""; // folder instead of MongoDB (used for testing)
const EVERY_MS = Math.max(1, Number(process.env.KM_SNAPSHOT_SECONDS || 15)) * 1000;
const MAX_BYTES = 15 * 1024 * 1024; // a MongoDB document may hold 16 MB
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log("[persist] " + m);

function mongoStore() {
  const { MongoClient, Binary } = require("mongodb");
  let col = null;
  async function open() {
    if (col) return col;
    const client = new MongoClient(URI, { serverSelectionTimeoutMS: 10000 });
    await client.connect();
    col = (process.env.MONGODB_DB ? client.db(process.env.MONGODB_DB) : client.db()).collection("km_snapshot");
    return col;
  }
  return {
    async load(name) {
      const d = await (await open()).findOne({ _id: name });
      if (!d || !d.data) return null;
      const b = d.data.buffer;
      return Buffer.from(b.subarray(0, d.data.position == null ? b.length : d.data.position));
    },
    async save(name, buf) {
      await (await open()).replaceOne({ _id: name }, { _id: name, data: new Binary(buf), bytes: buf.length, savedAt: new Date() }, { upsert: true });
    },
  };
}

function fileStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return {
    async load(name) { try { return fs.readFileSync(path.join(dir, name + ".gz")); } catch (e) { if (e.code === "ENOENT") return null; throw e; } },
    async save(name, buf) { const f = path.join(dir, name + ".gz"); fs.writeFileSync(f + ".tmp", buf); fs.renameSync(f + ".tmp", f); },
  };
}

async function restore(store) {
  if (fs.existsSync(DB_FILE)) return; // the data is already here (for example when run on a computer with a disk)
  let snap = null, failed = null;
  for (let i = 0; i < 4; i++) {
    try { snap = await store.load("km.db"); failed = null; break; }
    catch (e) { failed = e; console.error("[persist] Could not read the saved data (try " + (i + 1) + " of 4): " + e.message); await sleep(3000 * (i + 1)); }
  }
  if (!failed && snap) {
    try { fs.writeFileSync(DB_FILE, zlib.gunzipSync(snap)); log("Restored the saved data (" + Math.round(snap.length / 1024) + " KB compressed)."); }
    catch (e) { failed = e; console.error("[persist] The saved data is damaged: " + e.message); }
  }
  if (failed) {
    console.error("[persist] Stopping on purpose so the saved data is not overwritten by an empty database. Render will try again.");
    process.exit(1);
  }
  if (!snap) log("No saved data yet. Starting fresh; the first copy is saved in a few seconds.");
}

function startSaving(store) {
  const reader = new DatabaseSync(DB_FILE);
  reader.exec("PRAGMA busy_timeout = 5000");
  let seen = -1, lastBackup = 0, chain = Promise.resolve();

  async function save(force) {
    try {
      const v = reader.prepare("PRAGMA data_version").get().data_version; // changes whenever the app writes
      if (!force && v === seen) return;
      const tmp = path.join(os.tmpdir(), "km-snap-" + process.pid + ".db");
      try { fs.unlinkSync(tmp); } catch (e) { /* none */ }
      reader.exec("VACUUM INTO '" + tmp.replace(/'/g, "''") + "'"); // a consistent copy, safe while the app is writing
      const gz = zlib.gzipSync(fs.readFileSync(tmp));
      fs.unlinkSync(tmp);
      if (gz.length > MAX_BYTES) { console.error("[persist] The data is too big to save (" + Math.round(gz.length / 1048576) + " MB). Ask for help."); return; }
      await store.save("km.db", gz);
      if (Date.now() - lastBackup > 6 * 3600 * 1000) { await store.save("km.db.backup", gz); lastBackup = Date.now(); }
      seen = v;
    } catch (e) { console.error("[persist] Save failed, will retry: " + e.message); }
  }
  const run = (force) => (chain = chain.then(() => save(force)));

  setTimeout(() => run(true), 5000);
  setInterval(() => run(false), EVERY_MS);

  let closing = false;
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, async () => {
      if (closing) return;
      closing = true;
      log("Stopping: saving the latest data.");
      await Promise.race([run(true), sleep(10000)]);
      process.exit(0);
    });
  }
  log("Saving to " + (FILE_DIR ? "a folder" : "MongoDB") + " every " + EVERY_MS / 1000 + " seconds when something changes.");
}

(async () => {
  const store = FILE_DIR ? fileStore(FILE_DIR) : URI ? mongoStore() : null;
  if (!store) {
    console.log("[persist] MONGODB_URI is not set, so KM data is kept only until the next restart.");
    require("./server.js");
    return;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  await restore(store);
  require("./server.js"); // opens km.db (and creates the first admin if the database is new)
  startSaving(store);
})().catch((e) => { console.error("[persist] " + (e && e.stack || e)); process.exit(1); });
