"use strict";
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const webpush = require("web-push");
const { DatabaseSync } = require("node:sqlite");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
// minutes as returned by Date.getTimezoneOffset(): India is -330
const envTz = process.env.DEFAULT_TZ_OFFSET;
const DEFAULT_TZ = envTz !== undefined && envTz !== "" && Number.isFinite(Number(envTz)) ? Number(envTz) : -330;
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, "km.db"));
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

/* ---------- schema ---------- */
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','executive')),
  rate_per_km REAL NOT NULL DEFAULT 6,
  vehicle TEXT NOT NULL DEFAULT '',
  base_name TEXT NOT NULL DEFAULT '',
  base_lat REAL,
  base_lng REAL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  place TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  in_at INTEGER NOT NULL,
  in_lat REAL NOT NULL, in_lng REAL NOT NULL, in_acc REAL,
  out_at INTEGER,
  out_lat REAL, out_lng REAL, out_acc REAL,
  toll REAL NOT NULL DEFAULT 0,
  parking REAL NOT NULL DEFAULT 0,
  other REAL NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  stay_min REAL,
  leg_km REAL NOT NULL DEFAULT 0,
  leg_from TEXT NOT NULL DEFAULT '',
  counted_km REAL NOT NULL DEFAULT 0,
  rate REAL NOT NULL DEFAULT 0,
  flags TEXT NOT NULL DEFAULT '[]',
  counted INTEGER NOT NULL DEFAULT 0,
  admin_note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS visits_user_in ON visits(user_id, in_at);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  start_at INTEGER NOT NULL,
  end_at INTEGER,
  last_at INTEGER NOT NULL,
  last_t INTEGER,
  km REAL NOT NULL DEFAULT 0,
  ignored_km REAL NOT NULL DEFAULT 0,
  points INTEGER NOT NULL DEFAULT 0,
  rate REAL NOT NULL DEFAULT 0,
  anchor_t INTEGER, anchor_lat REAL, anchor_lng REAL,
  last_lat REAL, last_lng REAL, last_acc REAL,
  flags TEXT NOT NULL DEFAULT '{}',
  ended_by TEXT NOT NULL DEFAULT '',
  admin_km REAL,
  admin_note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS shifts_user_start ON shifts(user_id, start_at);
CREATE TABLE IF NOT EXISTS points (
  shift_id INTEGER NOT NULL REFERENCES shifts(id),
  t INTEGER NOT NULL,
  lat REAL NOT NULL, lng REAL NOT NULL, acc REAL,
  km REAL NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS points_shift_t ON points(shift_id, t);
`);
// upgrade databases made by the first version
if (!db.prepare("PRAGMA table_info(users)").all().some((c) => c.name === "pending")) {
  db.exec("ALTER TABLE users ADD COLUMN pending INTEGER NOT NULL DEFAULT 0");
}
function addColumn(table, col, def) {
  if (!db.prepare("PRAGMA table_info(" + table + ")").all().some((c) => c.name === col)) db.exec("ALTER TABLE " + table + " ADD COLUMN " + col + " " + def);
}
addColumn("users", "notif_seen", "INTEGER NOT NULL DEFAULT 0");
addColumn("visits", "near_t", "INTEGER");
addColumn("visits", "away_since", "INTEGER");
addColumn("visits", "auto_out", "INTEGER NOT NULL DEFAULT 0");
addColumn("shifts", "cl_lat", "REAL");
addColumn("shifts", "cl_lng", "REAL");
addColumn("shifts", "cl_since", "INTEGER");
addColumn("shifts", "cl_last", "INTEGER");
addColumn("shifts", "stop_id", "INTEGER");
db.exec(`
CREATE TABLE IF NOT EXISTS stops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  shift_id INTEGER NOT NULL,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  lat REAL NOT NULL, lng REAL NOT NULL,
  kind TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS stops_user_start ON stops(user_id, start_at);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  user_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);

const DEFAULTS = {
  minLegKm: 5,          // visit check: places closer than this are short hops
  minStayMin: 5,        // visit check: shorter stays are flagged
  maxSpeedKmh: 120,     // faster than this between two GPS readings is fake or skipped
  roadFactor: 1.2,      // visit check only: straight line x this = road estimate
  checkoutRadiusM: 500, // visit check: check-out must be near check-in
  maxAccuracyM: 200,    // visit check: weak GPS flag
  trackAccuracyM: 100,  // live tracking: readings less accurate than this are skipped
  stationaryM: 25,      // live tracking: movement under this is GPS drift, not counted
  maxGapMin: 15,        // live tracking: silence longer than this while moving is not counted
  shiftTimeoutMin: 120, // a shift with no signal this long is closed automatically
  registrationOpen: 1,  // 1 = people can register (admin must approve), 0 = closed
  stopMin: 5,           // vehicle still for this long = a stop is recorded and you are alerted
  stopRadiusM: 60,      // staying within this distance counts as standing still
  autoOutM: 300,        // moving farther than this from the check-in place starts auto check-out
  autoOutMin: 2         // ...after being away this many minutes
};
function getSettings() {
  const s = { ...DEFAULTS };
  for (const r of db.prepare("SELECT key, value FROM settings").all()) {
    if (r.key in DEFAULTS) s[r.key] = Number(r.value);
  }
  return s;
}
function setting(key, make) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  if (row) return row.value;
  const v = make();
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(key, v);
  return v;
}
const JWT_SECRET = process.env.JWT_SECRET || setting("jwt_secret", () => crypto.randomBytes(48).toString("hex"));
// keys for pop-up alerts. On a host that wipes its disk, set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY so they stay the same.
let VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY, VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
  const pair = JSON.parse(setting("vapid_json", () => JSON.stringify(webpush.generateVAPIDKeys())));
  VAPID_PUBLIC = pair.publicKey; VAPID_PRIVATE = pair.privateKey;
}
webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@example.com", VAPID_PUBLIC, VAPID_PRIVATE);

/* ---------- first-run admin ---------- */
if (db.prepare("SELECT COUNT(*) AS n FROM users").get().n === 0) {
  const email = (process.env.ADMIN_EMAIL || "admin@example.com").toLowerCase();
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString("base64url");
  db.prepare("INSERT INTO users (name, email, password_hash, role, rate_per_km, created_at) VALUES (?,?,?,?,?,?)")
    .run("Administrator", email, bcrypt.hashSync(password, 10), "admin", 0, Date.now());
  console.log("\n  First run: admin account created");
  console.log("  Email:    " + email);
  console.log("  Password: " + (process.env.ADMIN_PASSWORD ? "(from ADMIN_PASSWORD)" : password));
  console.log("  Change this password after logging in.\n");
}

/* ---------- helpers ---------- */
function hav(aLat, aLng, bLat, bLng) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad, dLng = (bLng - aLng) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}
const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const money = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n < 1e7 ? round2(n) : 0; };
function validCoords(lat, lng) {
  return typeof lat === "number" && typeof lng === "number" && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
}
function str(v, max) { return String(v == null ? "" : v).trim().slice(0, max); }
function tzOf(v) { const n = Number(v); return Number.isFinite(n) && v !== "" && v != null ? n : DEFAULT_TZ; }
function monthRange(month, tz) {
  const m = /^(\d{4})-(\d{2})$/.exec(month || "");
  if (!m || +m[2] < 1 || +m[2] > 12) return null;
  const y = +m[1], mo = +m[2] - 1;
  return [Date.UTC(y, mo, 1) + tz * 60000, Date.UTC(y, mo + 1, 1) + tz * 60000];
}
function dayRange(tz) {
  const local = Date.now() - tz * 60000;
  const start = Math.floor(local / 86400000) * 86400000 + tz * 60000;
  return [start, start + 86400000];
}
function currentMonth(tz) { return new Date(Date.now() - tz * 60000).toISOString().slice(0, 7); }

/* ---------- alerts for admins: saved in the app and sent as pop-ups ---------- */
function pushAll(payload) {
  const subs = db.prepare("SELECT s.* FROM push_subs s JOIN users u ON u.id = s.user_id WHERE u.role = 'admin' AND u.active = 1").all();
  for (const sub of subs) {
    webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), { TTL: 3600, urgency: "high" })
      .catch((e) => {
        if (e && (e.statusCode === 404 || e.statusCode === 410)) db.prepare("DELETE FROM push_subs WHERE id = ?").run(sub.id);
        else console.error("push failed:", e && (e.statusCode || e.message));
      });
  }
}
function notify(kind, title, body, userId) {
  const info = db.prepare("INSERT INTO notifications (kind, title, body, user_id, created_at) VALUES (?,?,?,?,?)").run(kind, title, body, userId || null, Date.now());
  try { pushAll({ id: Number(info.lastInsertRowid), kind, title, body, url: "/#alerts" }); } catch (e) { console.error("push error:", e.message); }
}
db.prepare("DELETE FROM notifications WHERE created_at < ?").run(Date.now() - 60 * 86400000);

/* ---------- app ---------- */
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(self)");
  next();
});
// state-changing calls must be JSON, which a cross-site form cannot send
app.use("/api", (req, res, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && !req.is("application/json")) {
    return res.status(415).json({ error: "Send JSON." });
  }
  next();
});

const fails = new Map();
function tooManyFails(key) { const f = fails.get(key); return f && f.n >= 6 && Date.now() - f.t < 15 * 60000; }
function noteFail(key) {
  const f = fails.get(key);
  if (!f || Date.now() - f.t > 15 * 60000) fails.set(key, { n: 1, t: Date.now() });
  else { f.n++; f.t = Date.now(); }
}

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, ratePerKm: u.rate_per_km, vehicle: u.vehicle,
    baseName: u.base_name, baseLat: u.base_lat, baseLng: u.base_lng, active: !!u.active, pending: !!u.pending };
}
function userFromCookie(req) {
  const token = req.cookies.km_token;
  if (!token) return null;
  try {
    const p = jwt.verify(token, JWT_SECRET);
    return db.prepare("SELECT * FROM users WHERE id = ? AND active = 1").get(p.id) || null;
  } catch (e) { return null; }
}
function auth(req, res, next) {
  const u = userFromCookie(req);
  if (!u) return res.status(401).json({ error: "Please sign in." });
  req.user = u;
  next();
}
function adminOnly(req, res, next) {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only." });
  next();
}
function execOnly(req, res, next) {
  if (req.user.role !== "executive") return res.status(403).json({ error: "Executives only." });
  next();
}

/* ---------- shifts: login to logout ---------- */
const SHIFT_SQL = "SELECT s.*, u.name AS user_name FROM shifts s JOIN users u ON u.id = s.user_id";

function flagList(obj, S) {
  const text = {
    speed: "Moved faster than " + S.maxSpeedKmh + " km/h between two readings (not counted)",
    jump: "Location jumped a long way almost instantly (not counted)",
    gap: "No signal for over " + S.maxGapMin + " min while the phone moved (not counted)",
    weak_gps: "Readings weaker than " + S.trackAccuracyM + " m were skipped",
    badtime: "Readings with a wrong timestamp were skipped"
  };
  return Object.keys(obj).filter((k) => text[k]).map((k) => ({ type: k, text: text[k], count: obj[k] }));
}
function shiftDto(s, S) {
  const eff = round1(s.admin_km != null ? s.admin_km : s.km); // claim uses the km shown on screen
  const end = s.end_at != null ? s.end_at : s.last_at;
  return {
    id: s.id, userId: s.user_id, userName: s.user_name, startAt: s.start_at, endAt: s.end_at, lastAt: s.last_at,
    open: s.end_at == null, trackedKm: round1(s.km), ignoredKm: round1(s.ignored_km), km: round1(eff),
    adminKm: s.admin_km, adminNote: s.admin_note, points: s.points, rate: s.rate, allowance: round2(eff * s.rate),
    hours: round2(Math.max(0, end - s.start_at) / 3600000), flags: flagList(JSON.parse(s.flags || "{}"), S), endedBy: s.ended_by
  };
}
function closeOpenShifts(userId, by) {
  for (const x of db.prepare("SELECT * FROM shifts WHERE user_id = ? AND end_at IS NULL").all(userId)) {
    db.prepare("UPDATE shifts SET end_at = ?, ended_by = ? WHERE id = ?").run(by === "logout" ? Date.now() : x.last_at, by, x.id);
  }
}
function startShift(user) {
  closeOpenShifts(user.id, "replaced");
  const now = Date.now();
  const info = db.prepare("INSERT INTO shifts (user_id, start_at, last_at, rate) VALUES (?,?,?,?)").run(user.id, now, now, user.rate_per_km);
  return db.prepare("SELECT * FROM shifts WHERE id = ?").get(Number(info.lastInsertRowid));
}
function openShift(user) { return db.prepare("SELECT * FROM shifts WHERE user_id = ? AND end_at IS NULL").get(user.id); }

// close shifts that stopped reporting
function sweepShifts() {
  const S = getSettings(), limit = Date.now() - S.shiftTimeoutMin * 60000;
  db.prepare("UPDATE shifts SET end_at = last_at, ended_by = 'timeout' WHERE end_at IS NULL AND last_at < ?").run(limit);
}
sweepShifts();
setInterval(sweepShifts, 60000).unref();
db.prepare("DELETE FROM points WHERE t < ?").run(Date.now() - 120 * 86400000);

/* Close a visit on the executive's behalf (he drove away, or signed out, without checking out). */
function autoCheckout(ov, user, S, outAt, outLat, outLng, reason) {
  const v = { ...ov, out_at: outAt, out_lat: outLat, out_lng: outLng, out_acc: null };
  const r = finalise(v, user, S);
  const flags = JSON.parse(r.flags);
  flags.push({ type: "auto_checkout", text: reason });
  db.prepare(`UPDATE visits SET out_at=?, out_lat=?, out_lng=?, out_acc=NULL, stay_min=?, leg_km=?, leg_from=?, counted_km=?, rate=?,
              flags=?, counted=?, auto_out=1, away_since=NULL WHERE id=?`)
    .run(outAt, outLat, outLng, r.stay_min, r.leg_km, r.leg_from, r.counted_km, user.rate_per_km, JSON.stringify(flags), r.counted, ov.id);
  return r;
}

/* Live km. Every point is judged against the last counted point, using times from the server's clock window.
   Drift, weak GPS, impossible speed, teleport jumps and silent gaps are not counted.
   The same readings also find vehicle stops and visits the executive drove away from without checking out. */
function ingest(shift, pts, S, user) {
  const now = Date.now();
  const flags = JSON.parse(shift.flags || "{}");
  const bump = (k) => { flags[k] = (flags[k] || 0) + 1; };
  let km = shift.km, ignored = shift.ignored_km, count = shift.points;
  let anchor = shift.anchor_t != null ? { lat: shift.anchor_lat, lng: shift.anchor_lng } : null;
  let lastT = shift.last_t, lastLat = shift.last_lat, lastLng = shift.last_lng, lastAcc = shift.last_acc;
  let cl = shift.cl_lat != null ? { lat: shift.cl_lat, lng: shift.cl_lng, since: shift.cl_since, last: shift.cl_last } : null;
  let stopId = shift.stop_id;
  let ov = db.prepare("SELECT * FROM visits WHERE user_id = ? AND out_at IS NULL").get(shift.user_id);
  ov = ov ? { ...ov } : null;
  const events = [];
  const ins = db.prepare("INSERT INTO points (shift_id, t, lat, lng, acc, km, ok) VALUES (?,?,?,?,?,?,?)");
  const list = pts.filter((p) => p && typeof p === "object").map((p) => ({ t: Number(p.t), lat: p.lat, lng: p.lng, acc: Number.isFinite(p.acc) ? p.acc : null }))
    .sort((a, b) => a.t - b.t);
  db.exec("BEGIN");
  try {
    for (const p of list) {
      if (!validCoords(p.lat, p.lng)) continue;
      if (!Number.isFinite(p.t) || p.t > now + 60000 || p.t < shift.start_at - 60000 || (lastT != null && p.t <= lastT)) { bump("badtime"); continue; }
      if (p.acc != null && p.acc > S.trackAccuracyM) { bump("weak_gps"); continue; }

      // 1. vehicle standing still: a stop
      const rad = Math.max(S.stopRadiusM, 0.5 * (p.acc || 0));
      if (!cl) cl = { lat: p.lat, lng: p.lng, since: p.t, last: p.t };
      else if (hav(cl.lat, cl.lng, p.lat, p.lng) * 1000 <= rad) {
        cl.last = p.t;
        if (stopId) db.prepare("UPDATE stops SET end_at = ? WHERE id = ?").run(p.t, stopId);
        else if (p.t - cl.since >= S.stopMin * 60000) {
          const atVisit = !!(ov && cl.since >= ov.in_at - 60000 && hav(ov.in_lat, ov.in_lng, cl.lat, cl.lng) * 1000 <= S.autoOutM);
          const info = db.prepare("INSERT INTO stops (user_id, shift_id, start_at, end_at, lat, lng, kind) VALUES (?,?,?,?,?,?,?)")
            .run(shift.user_id, shift.id, cl.since, p.t, cl.lat, cl.lng, atVisit ? "visit" : "");
          stopId = Number(info.lastInsertRowid);
          if (!atVisit) events.push({ kind: "stop", title: user.name + " stopped the vehicle", body: "Standing still for " + Math.round((p.t - cl.since) / 60000) + " min. It may be a toll or parking. He has been asked to say which.", userId: user.id });
        }
      } else { stopId = null; cl = { lat: p.lat, lng: p.lng, since: p.t, last: p.t }; }

      // 2. drove away from the visit place without checking out
      if (ov && p.t >= ov.in_at) {
        const dm = hav(ov.in_lat, ov.in_lng, p.lat, p.lng) * 1000;
        if (dm <= S.autoOutM) { ov.near_t = p.t; ov.away_since = null; }
        else if (ov.away_since == null) ov.away_since = p.t;
        else if (p.t - ov.away_since >= S.autoOutMin * 60000) {
          const outAt = Math.max(ov.near_t || ov.in_at, ov.in_at);
          const r = autoCheckout(ov, user, S, outAt, ov.in_lat, ov.in_lng, "Checked out automatically after he left the place");
          events.push({ kind: "autoout", title: user.name + " was checked out automatically", body: "He left " + ov.place + " without checking out. Stayed " + Math.round(r.stay_min) + " min.", userId: user.id });
          ov = null;
        }
      }

      // 3. km
      if (!anchor) {
        anchor = { lat: p.lat, lng: p.lng };
        ins.run(shift.id, p.t, p.lat, p.lng, p.acc, 0, 1); count++;
        lastT = p.t; lastLat = p.lat; lastLng = p.lng; lastAcc = p.acc;
        continue;
      }
      const d = hav(anchor.lat, anchor.lng, p.lat, p.lng);
      const dtMin = (p.t - lastT) / 60000;
      lastT = p.t; lastLat = p.lat; lastLng = p.lng; lastAcc = p.acc;
      if (d * 1000 < Math.max(S.stationaryM, 0.5 * (p.acc || 0))) continue; // standing still, or GPS drift
      const speed = d / (Math.max(dtMin, 1e-6) / 60);
      if (speed > S.maxSpeedKmh) {
        bump(d > 25 && dtMin < 2 ? "jump" : "speed");
        ignored += d; anchor = { lat: p.lat, lng: p.lng };
        ins.run(shift.id, p.t, p.lat, p.lng, p.acc, 0, 0); count++;
        continue;
      }
      if (dtMin > S.maxGapMin) {
        bump("gap");
        ignored += d; anchor = { lat: p.lat, lng: p.lng };
        ins.run(shift.id, p.t, p.lat, p.lng, p.acc, 0, 1); count++;
        continue;
      }
      km += d; anchor = { lat: p.lat, lng: p.lng };
      ins.run(shift.id, p.t, p.lat, p.lng, p.acc, d, 1); count++;
    }
    if (ov) db.prepare("UPDATE visits SET near_t = ?, away_since = ? WHERE id = ?").run(ov.near_t == null ? null : ov.near_t, ov.away_since == null ? null : ov.away_since, ov.id);
    db.prepare(`UPDATE shifts SET km = ?, ignored_km = ?, points = ?, flags = ?, anchor_t = ?, anchor_lat = ?, anchor_lng = ?,
                last_t = ?, last_lat = ?, last_lng = ?, last_acc = ?, last_at = ?, cl_lat = ?, cl_lng = ?, cl_since = ?, cl_last = ?, stop_id = ? WHERE id = ?`)
      .run(km, ignored, count, JSON.stringify(flags), anchor ? lastT : null, anchor ? anchor.lat : null, anchor ? anchor.lng : null,
        lastT == null ? null : lastT, lastLat == null ? null : lastLat, lastLng == null ? null : lastLng, lastAcc == null ? null : lastAcc, now,
        cl ? cl.lat : null, cl ? cl.lng : null, cl ? cl.since : null, cl ? cl.last : null, stopId == null ? null : stopId, shift.id);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  for (const ev of events) notify(ev.kind, ev.title, ev.body, ev.userId);
}

function currentInfo(user, tz) {
  const S = getSettings();
  const row = openShift(user);
  const [a, b] = dayRange(tz);
  const today = db.prepare("SELECT * FROM shifts WHERE user_id = ? AND start_at >= ? AND start_at < ?").all(user.id, a, b);
  const effKm = (x) => round1(x.admin_km != null ? x.admin_km : x.km);
  const todayKm = round1(today.reduce((s, x) => s + effKm(x), 0));
  const todayAllowance = round2(today.reduce((s, x) => s + effKm(x) * x.rate, 0));
  const unlabeled = db.prepare("SELECT COUNT(*) AS n FROM stops WHERE user_id = ? AND start_at >= ? AND start_at < ? AND kind = ''").get(user.id, a, b).n;
  const ao = db.prepare("SELECT id, place, out_at FROM visits WHERE user_id = ? AND auto_out = 1 AND out_at > ? ORDER BY out_at DESC LIMIT 1").get(user.id, Date.now() - 30 * 60000);
  return { shift: row ? shiftDto({ ...row, user_name: user.name }, S) : null, todayKm, todayAllowance, serverNow: Date.now(),
    unlabeled, autoOut: ao ? { id: ao.id, place: ao.place, outAt: ao.out_at } : null };
}

/* ---------- registration and login ---------- */
const regHits = new Map();
app.post("/api/register", (req, res) => {
  const S = getSettings();
  if (!S.registrationOpen) return res.status(403).json({ error: "Registration is closed. Ask your admin to create your account." });
  const ip = req.ip || "x", recent = (regHits.get(ip) || []).filter((t) => Date.now() - t < 3600000);
  if (recent.length >= 5) return res.status(429).json({ error: "Too many sign-ups from this network. Try again later." });
  const name = str(req.body.name, 80), email = str(req.body.email, 200).toLowerCase(), password = String(req.body.password || "");
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Enter your name and a valid email." });
  if (password.length < 8) return res.status(400).json({ error: "Password needs at least 8 characters." });
  if (db.prepare("SELECT id FROM users WHERE email = ?").get(email)) return res.status(409).json({ error: "That email already has an account." });
  db.prepare("INSERT INTO users (name, email, password_hash, role, vehicle, active, pending, created_at) VALUES (?,?,?,?,?,0,1,?)")
    .run(name, email, bcrypt.hashSync(password, 10), "executive", str(req.body.vehicle, 40), Date.now());
  recent.push(Date.now()); regHits.set(ip, recent);
  notify("register", name + " registered", "Waiting for your approval. Open the Team tab to approve and set the rate.", null);
  res.json({ ok: true });
});

app.post("/api/login", (req, res) => {
  const email = str(req.body.email, 200).toLowerCase();
  const password = String(req.body.password || "");
  const key = email + "|" + req.ip;
  if (tooManyFails(key)) return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
  const u = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!u || !bcrypt.compareSync(password, u.password_hash)) {
    noteFail(key);
    return res.status(401).json({ error: "Email or password is wrong." });
  }
  if (u.pending) return res.status(403).json({ error: "Your account is waiting for admin approval." });
  if (!u.active) return res.status(403).json({ error: "Your account is turned off. Contact your admin." });
  fails.delete(key);
  if (u.role === "executive") { startShift(u); notify("login", u.name + " signed in", "Started the day. Open the Map to see where he is.", u.id); }
  const token = jwt.sign({ id: u.id }, JWT_SECRET, { expiresIn: "12h" });
  res.cookie("km_token", token, { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", maxAge: 12 * 3600 * 1000 });
  res.json({ user: publicUser(u) });
});
app.post("/api/logout", (req, res) => {
  const u = userFromCookie(req);
  if (u && u.role === "executive") {
    const ov = db.prepare("SELECT * FROM visits WHERE user_id = ? AND out_at IS NULL").get(u.id);
    if (ov) {
      const sh = openShift(u);
      autoCheckout(ov, u, getSettings(), Date.now(), sh && sh.last_lat != null ? sh.last_lat : ov.in_lat, sh && sh.last_lng != null ? sh.last_lng : ov.in_lng, "Checked out automatically when he signed out");
    }
    closeOpenShifts(u.id, "logout");
  }
  res.clearCookie("km_token");
  res.json({ ok: true });
});
// map tiles: OpenStreetMap is fine for a small team. For heavy use set TILE_URL to a paid tile service.
const TILE_URL = process.env.TILE_URL || "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
app.get("/api/me", auth, (req, res) => res.json({ user: publicUser(req.user), settings: getSettings(), tileUrl: TILE_URL }));
app.post("/api/me/password", auth, (req, res) => {
  const { current, next } = req.body;
  if (!bcrypt.compareSync(String(current || ""), req.user.password_hash)) return res.status(400).json({ error: "Current password is wrong." });
  if (String(next || "").length < 8) return res.status(400).json({ error: "New password needs at least 8 characters." });
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(bcrypt.hashSync(String(next), 10), req.user.id);
  res.json({ ok: true });
});
app.put("/api/me/base", auth, (req, res) => {
  const { lat, lng } = req.body;
  if (!validCoords(lat, lng)) return res.status(400).json({ error: "Location not valid." });
  db.prepare("UPDATE users SET base_lat = ?, base_lng = ?, base_name = ? WHERE id = ?")
    .run(lat, lng, str(req.body.name, 80) || "Start point", req.user.id);
  res.json({ ok: true });
});

/* ---------- live tracking (executive) ---------- */
app.get("/api/shift/current", auth, execOnly, (req, res) => {
  if (!openShift(req.user)) startShift(req.user);
  res.json(currentInfo(req.user, tzOf(req.query.tz)));
});
app.post("/api/track", auth, execOnly, (req, res) => {
  let shift = openShift(req.user);
  if (!shift) shift = startShift(req.user);
  const pts = Array.isArray(req.body.points) ? req.body.points.slice(0, 100) : [];
  ingest(shift, pts, getSettings(), req.user);
  res.json(currentInfo(req.user, tzOf(req.body.tz)));
});

/* ---------- check in / check out ---------- */
function visitDto(v) {
  const costs = round2(v.toll + v.parking + v.other);
  return {
    id: v.id, userId: v.user_id, userName: v.user_name, place: v.place, purpose: v.purpose,
    inAt: v.in_at, outAt: v.out_at, stayMin: v.stay_min == null ? null : round1(v.stay_min),
    legFrom: v.leg_from, legKm: round1(v.leg_km), countedKm: round1(v.counted_km),
    toll: v.toll, parking: v.parking, other: v.other, costs,
    flags: JSON.parse(v.flags || "[]"), counted: !!v.counted, open: v.out_at == null, note: v.note, autoOut: !!v.auto_out
  };
}
const VISIT_SQL = "SELECT v.*, u.name AS user_name FROM visits v JOIN users u ON u.id = v.user_id";

app.get("/api/visits/open", auth, (req, res) => {
  const v = db.prepare(VISIT_SQL + " WHERE v.user_id = ? AND v.out_at IS NULL").get(req.user.id);
  res.json({ visit: v ? visitDto(v) : null });
});
app.get("/api/visits/today", auth, (req, res) => {
  const [a, b] = dayRange(tzOf(req.query.tz));
  const rows = db.prepare(VISIT_SQL + " WHERE v.user_id = ? AND v.in_at >= ? AND v.in_at < ? ORDER BY v.in_at DESC").all(req.user.id, a, b);
  res.json({ visits: rows.map(visitDto) });
});
app.post("/api/checkin", auth, execOnly, (req, res) => {
  const { lat, lng, accuracy } = req.body;
  const place = str(req.body.place, 120);
  if (!place) return res.status(400).json({ error: "Enter the name of the place you are visiting." });
  if (!validCoords(lat, lng)) return res.status(400).json({ error: "Could not read your location. Allow location access and try again." });
  if (db.prepare("SELECT id FROM visits WHERE user_id = ? AND out_at IS NULL").get(req.user.id)) {
    return res.status(409).json({ error: "You are already checked in. Check out first." });
  }
  const acc = Number.isFinite(accuracy) ? accuracy : null;
  const info = db.prepare("INSERT INTO visits (user_id, place, purpose, in_at, in_lat, in_lng, in_acc) VALUES (?,?,?,?,?,?,?)")
    .run(req.user.id, place, str(req.body.purpose, 200), Date.now(), lat, lng, acc);
  res.json({ visit: visitDto(db.prepare(VISIT_SQL + " WHERE v.id = ?").get(Number(info.lastInsertRowid))) });
});

// Distance between places is a cross-check only. The claim comes from the live km of the shift.
function finalise(visit, user, S) {
  const flags = [];
  const stayMin = (visit.out_at - visit.in_at) / 60000;
  let blocked = false;
  if ((visit.in_acc != null && visit.in_acc > S.maxAccuracyM) || (visit.out_acc != null && visit.out_acc > S.maxAccuracyM)) {
    flags.push({ type: "accuracy", text: "GPS accuracy was weaker than " + S.maxAccuracyM + " m" });
  }
  const drift = hav(visit.in_lat, visit.in_lng, visit.out_lat, visit.out_lng) * 1000;
  if (drift > S.checkoutRadiusM) {
    flags.push({ type: "far_checkout", text: "Checked out " + Math.round(drift) + " m from the check-in point (limit " + S.checkoutRadiusM + " m)" });
    blocked = true;
  }
  if (stayMin < S.minStayMin) {
    flags.push({ type: "short_stay", text: "Stayed " + round1(stayMin) + " min, under the " + S.minStayMin + " min minimum" });
    blocked = true;
  }
  const prev = db.prepare("SELECT * FROM visits WHERE user_id = ? AND out_at IS NOT NULL AND out_at <= ? AND id <> ? ORDER BY out_at DESC LIMIT 1")
    .get(user.id, visit.in_at, visit.id);
  let origin = null, legFrom = "";
  if (prev && visit.in_at - prev.out_at < 16 * 3600 * 1000) {
    origin = { lat: prev.out_lat, lng: prev.out_lng, at: prev.out_at }; legFrom = prev.place;
  } else if (user.base_lat != null) {
    origin = { lat: user.base_lat, lng: user.base_lng, at: null }; legFrom = user.base_name || "Start point";
  }
  let legKm = 0;
  if (!origin) {
    flags.push({ type: "no_origin", text: "No earlier check-out or start point to measure from" });
    blocked = true;
  } else {
    legKm = hav(origin.lat, origin.lng, visit.in_lat, visit.in_lng) * S.roadFactor;
    if (origin.at != null) {
      const hours = (visit.in_at - origin.at) / 3600000;
      const speed = hours > 0 ? legKm / hours : Infinity;
      if (legKm > 1 && speed > S.maxSpeedKmh) {
        flags.push({ type: "speed", text: "Travelled at about " + Math.round(Math.min(speed, 9999)) + " km/h, above the " + S.maxSpeedKmh + " km/h limit" });
        blocked = true;
      }
    }
    if (legKm < S.minLegKm) {
      flags.push({ type: "short_hop", text: round1(legKm) + " km from the last place, under the " + S.minLegKm + " km minimum" });
      blocked = true;
    }
  }
  return { stay_min: stayMin, leg_km: legKm, leg_from: legFrom, counted_km: blocked ? 0 : round1(legKm), counted: blocked ? 0 : 1, flags: JSON.stringify(flags) };
}
app.post("/api/checkout", auth, execOnly, (req, res) => {
  const { lat, lng, accuracy } = req.body;
  if (!validCoords(lat, lng)) return res.status(400).json({ error: "Could not read your location. Allow location access and try again." });
  const open = db.prepare("SELECT * FROM visits WHERE user_id = ? AND out_at IS NULL").get(req.user.id);
  if (!open) return res.status(409).json({ error: "You are not checked in." });
  const v = { ...open, out_at: Date.now(), out_lat: lat, out_lng: lng, out_acc: Number.isFinite(accuracy) ? accuracy : null };
  const r = finalise(v, req.user, getSettings());
  db.prepare(`UPDATE visits SET out_at=?, out_lat=?, out_lng=?, out_acc=?, toll=?, parking=?, other=?, note=?,
              stay_min=?, leg_km=?, leg_from=?, counted_km=?, rate=?, flags=?, counted=? WHERE id=?`)
    .run(v.out_at, lat, lng, v.out_acc, money(req.body.toll), money(req.body.parking), money(req.body.other),
      str(req.body.note, 300), r.stay_min, r.leg_km, r.leg_from, r.counted_km, req.user.rate_per_km, r.flags, r.counted, v.id);
  res.json({ visit: visitDto(db.prepare(VISIT_SQL + " WHERE v.id = ?").get(v.id)) });
});

/* ---------- reports ---------- */
function stopDto(r) {
  return { id: r.id, userId: r.user_id, userName: r.user_name, startAt: r.start_at, endAt: r.end_at, minutes: round1((r.end_at - r.start_at) / 60000),
    lat: r.lat, lng: r.lng, kind: r.kind, amount: r.amount, note: r.note };
}
const KIND_LABEL = { toll: "Toll", parking: "Parking", visit: "Client visit", other: "Other", "": "Not labelled" };
function reportFor(month, tz, userId) {
  const range = monthRange(month, tz);
  if (!range) return null;
  const S = getSettings();
  const uq = userId ? " AND s.user_id = ?" : "";
  const sArgs = userId ? [range[0], range[1], userId] : [range[0], range[1]];
  const shifts = db.prepare(SHIFT_SQL + " WHERE s.start_at >= ? AND s.start_at < ?" + uq + " ORDER BY u.name, s.start_at").all(...sArgs).map((r) => shiftDto(r, S));
  const vq = userId ? " AND v.user_id = ?" : "";
  const visits = db.prepare(VISIT_SQL + " WHERE v.in_at >= ? AND v.in_at < ? AND v.out_at IS NOT NULL" + vq + " ORDER BY u.name, v.in_at").all(...sArgs).map(visitDto);
  const stops = db.prepare("SELECT st.*, u.name AS user_name FROM stops st JOIN users u ON u.id = st.user_id WHERE st.start_at >= ? AND st.start_at < ? AND st.kind != 'visit'" + (userId ? " AND st.user_id = ?" : "") + " ORDER BY u.name, st.start_at")
    .all(...sArgs).map(stopDto);
  const blank = () => ({ shifts: 0, hours: 0, km: 0, allowance: 0, visits: 0, toll: 0, parking: 0, other: 0, costs: 0, total: 0 });
  const totals = blank(), by = {};
  const user = (id, name) => by[id] || (by[id] = { userId: id, name, ...blank() });
  for (const s of shifts) for (const t of [totals, user(s.userId, s.userName)]) { t.shifts++; t.hours += s.hours; t.km += s.km; t.allowance += s.allowance; }
  for (const v of visits) for (const t of [totals, user(v.userId, v.userName)]) { t.visits++; t.toll += v.toll; t.parking += v.parking; t.other += v.other; t.costs += v.costs; }
  for (const st of stops) for (const t of [totals, user(st.userId, st.userName)]) {
    if (["toll", "parking", "other"].includes(st.kind)) { t[st.kind] += st.amount; t.costs += st.amount; }
  }
  const fix = (t) => { t.hours = round2(t.hours); t.km = round1(t.km); for (const k of ["allowance", "toll", "parking", "other", "costs"]) t[k] = round2(t[k]); t.total = round2(t.allowance + t.costs); return t; };
  return { month, shifts, visits, stops, totals: fix(totals), byUser: Object.values(by).map(fix) };
}
function csvCell(v) {
  v = String(v == null ? "" : v);
  if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
function csvOf(rep, type, tz) {
  const t = (ms) => ms == null ? "" : new Date(ms - tz * 60000).toISOString().slice(0, 16).replace("T", " ");
  const d = (ms) => new Date(ms - tz * 60000).toISOString().slice(0, 10);
  const line = (a) => a.map(csvCell).join(",");
  const out = [];
  if (type === "visits") {
    out.push(line(["Executive", "Place", "Purpose", "Check in", "Check out", "Stay (min)", "Came from", "Km between places", "Toll", "Parking", "Other", "Costs", "Checks"]));
    for (const v of rep.visits) out.push(line([v.userName, v.place, v.purpose, t(v.inAt), t(v.outAt), v.stayMin, v.legFrom, v.legKm, v.toll, v.parking, v.other, v.costs, v.flags.map((f) => f.text).join("; ")]));
  } else if (type === "stops") {
    out.push(line(["Executive", "Date", "From", "To", "Minutes", "Type", "Amount", "Note", "Latitude", "Longitude"]));
    for (const x of rep.stops) out.push(line([x.userName, d(x.startAt), t(x.startAt), t(x.endAt), x.minutes, KIND_LABEL[x.kind] || x.kind, x.amount, x.note, x.lat, x.lng]));
  } else if (type === "shifts") {
    out.push(line(["Executive", "Date", "Login", "Logout", "Hours", "Tracked km", "Not counted km", "Km claimed", "Rate per km", "Allowance", "Ended by", "Checks", "Admin note"]));
    for (const s of rep.shifts) out.push(line([s.userName, d(s.startAt), t(s.startAt), s.open ? "" : t(s.endAt), s.hours, s.trackedKm, s.ignoredKm, s.km, s.rate, s.allowance, s.endedBy || (s.open ? "still logged in" : ""), s.flags.map((f) => f.text + (f.count > 1 ? " x" + f.count : "")).join("; "), s.adminNote]));
  } else {
    out.push(line(["Executive", "Shifts", "Hours", "Km claimed", "Allowance", "Visits", "Toll", "Parking", "Other", "Costs", "Total claim"]));
    for (const u of rep.byUser) out.push(line([u.name, u.shifts, u.hours, u.km, u.allowance, u.visits, u.toll, u.parking, u.other, u.costs, u.total]));
    const x = rep.totals;
    out.push(line(["Total", x.shifts, x.hours, x.km, x.allowance, x.visits, x.toll, x.parking, x.other, x.costs, x.total]));
  }
  return "﻿" + out.join("\r\n");
}
function sendCsv(res, rep, type, tz) {
  const t = ["visits", "shifts", "stops"].includes(type) ? type : "summary";
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="km-' + t + "-" + rep.month + '.csv"');
  res.send(csvOf(rep, t, tz));
}
function reportUserId(req) {
  if (req.user.role !== "admin") return req.user.id;
  return req.query.user && req.query.user !== "all" ? Number(req.query.user) || -1 : null;
}
app.get("/api/report", auth, (req, res) => {
  const rep = reportFor(String(req.query.month || ""), tzOf(req.query.tz), reportUserId(req));
  if (!rep) return res.status(400).json({ error: "Pick a month." });
  res.json(rep);
});
app.get("/api/report.csv", auth, (req, res) => {
  const tz = tzOf(req.query.tz);
  const rep = reportFor(String(req.query.month || ""), tz, reportUserId(req));
  if (!rep) return res.status(400).send("Pick a month.");
  sendCsv(res, rep, String(req.query.type || ""), tz);
});

/* ---------- reports for other systems (Excel, Google Sheets, your own software) ---------- */
function keyHash(k) { return crypto.createHash("sha256").update(k).digest("hex"); }
function extAuth(req, res, next) {
  const fk = "ext|" + req.ip;
  if (tooManyFails(fk)) return res.status(429).json({ error: "Too many wrong keys. Try again later." });
  const h = String(req.headers.authorization || "");
  const key = (h.startsWith("Bearer ") ? h.slice(7) : String(req.query.key || "")).trim();
  const row = db.prepare("SELECT value FROM settings WHERE key = 'api_key_hash'").get();
  if (!row || !key || !crypto.timingSafeEqual(Buffer.from(keyHash(key)), Buffer.from(row.value))) {
    noteFail(fk);
    return res.status(401).json({ error: "Missing or wrong API key." });
  }
  next();
}
// /api/external/summary.csv | visits.csv | shifts.csv | report.json   ?month=2026-10&email=ravi@x.com (optional)&tz=-330
app.get("/api/external/:file", extAuth, (req, res) => {
  const tz = tzOf(req.query.tz);
  const month = String(req.query.month || currentMonth(tz));
  let userId = null;
  if (req.query.email) {
    const u = db.prepare("SELECT id FROM users WHERE email = ?").get(String(req.query.email).toLowerCase());
    if (!u) return res.status(404).json({ error: "No executive with that email." });
    userId = u.id;
  }
  const rep = reportFor(month, tz, userId);
  if (!rep) return res.status(400).json({ error: "month must look like 2026-10." });
  const f = req.params.file;
  if (f === "report.json") return res.json(rep);
  const m = /^(summary|visits|shifts|stops)\.csv$/.exec(f);
  if (!m) return res.status(404).json({ error: "Use summary.csv, visits.csv, shifts.csv, stops.csv or report.json." });
  sendCsv(res, rep, m[1], tz);
});
app.get("/api/admin/api-key", auth, adminOnly, (req, res) => {
  res.json({ exists: !!db.prepare("SELECT 1 FROM settings WHERE key = 'api_key_hash'").get(), defaultTz: DEFAULT_TZ });
});
app.post("/api/admin/api-key", auth, adminOnly, (req, res) => {
  const key = "kmk_" + crypto.randomBytes(24).toString("base64url");
  db.prepare("INSERT INTO settings (key, value) VALUES ('api_key_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(keyHash(key));
  res.json({ key });
});
app.delete("/api/admin/api-key", auth, adminOnly, (req, res) => {
  db.prepare("DELETE FROM settings WHERE key = 'api_key_hash'").run();
  res.json({ ok: true });
});

/* ---------- live map (admin) ---------- */
app.get("/api/live", auth, adminOnly, (req, res) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(req.query.date || ""));
  if (!m) return res.status(400).json({ error: "Pick a date." });
  const tz = tzOf(req.query.tz), S = getSettings(), now = Date.now();
  const start = Date.UTC(+m[1], +m[2] - 1, +m[3]) + tz * 60000, end = start + 86400000;
  const people = db.prepare("SELECT * FROM users WHERE role = 'executive' AND active = 1 ORDER BY name").all();
  const shiftRows = db.prepare(SHIFT_SQL + " WHERE s.start_at < ? AND COALESCE(s.end_at, s.last_at) >= ? ORDER BY s.start_at").all(end, start);
  const visitRows = db.prepare(VISIT_SQL + " WHERE v.in_at >= ? AND v.in_at < ? ORDER BY v.in_at").all(start, end);
  const out = people.map((u) => {
    const mine = shiftRows.filter((s) => s.user_id === u.id);
    const open = mine.find((s) => s.end_at == null) || null;
    const lastShift = mine[mine.length - 1] || null;
    let trail = [];
    for (const s of mine) {
      for (const p of db.prepare("SELECT lat, lng FROM points WHERE shift_id = ? AND ok = 1 ORDER BY t").all(s.id)) trail.push([Math.round(p.lat * 1e5) / 1e5, Math.round(p.lng * 1e5) / 1e5]);
    }
    if (trail.length > 400) { const step = Math.ceil(trail.length / 400); trail = trail.filter((_, i) => i % step === 0 || i === trail.length - 1); }
    const posShift = open || lastShift;
    const visits = visitRows.filter((r) => r.user_id === u.id).map((r) => ({ ...visitDto(r), inLat: r.in_lat, inLng: r.in_lng, outLat: r.out_lat, outLng: r.out_lng }));
    const dtos = mine.map((s) => shiftDto(s, S));
    return {
      id: u.id, name: u.name, vehicle: u.vehicle,
      base: u.base_lat != null ? { lat: u.base_lat, lng: u.base_lng, name: u.base_name || "Start point" } : null,
      state: open ? (now - open.last_at <= 90000 ? "live" : "stale") : "off",
      lastSeenAt: posShift ? posShift.last_at : null, loginAt: open ? open.start_at : null,
      pos: posShift && posShift.last_lat != null ? { lat: posShift.last_lat, lng: posShift.last_lng, acc: posShift.last_acc } : null,
      km: round1(dtos.reduce((s, x) => s + x.km, 0)), hours: round1(dtos.reduce((s, x) => s + x.hours, 0)),
      allowance: round2(dtos.reduce((s, x) => s + x.allowance, 0)), costs: round2(visits.reduce((s, v) => s + v.costs, 0)),
      flags: dtos.reduce((n, x) => n + x.flags.length, 0), trail, visits,
      stops: db.prepare("SELECT st.*, u.name AS user_name FROM stops st JOIN users u ON u.id = st.user_id WHERE st.user_id = ? AND st.start_at >= ? AND st.start_at < ? ORDER BY st.start_at").all(u.id, start, end).map(stopDto)
    };
  });
  res.json({ date: req.query.date, now, executives: out });
});

/* ---------- admin ---------- */
app.get("/api/users", auth, adminOnly, (req, res) => {
  res.json({ users: db.prepare("SELECT * FROM users ORDER BY pending DESC, active DESC, name").all().map(publicUser) });
});
app.post("/api/users", auth, adminOnly, (req, res) => {
  const name = str(req.body.name, 80), email = str(req.body.email, 200).toLowerCase(), password = String(req.body.password || "");
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Enter a name and a valid email." });
  if (password.length < 8) return res.status(400).json({ error: "Password needs at least 8 characters." });
  if (db.prepare("SELECT id FROM users WHERE email = ?").get(email)) return res.status(409).json({ error: "That email already has an account." });
  const role = req.body.role === "admin" ? "admin" : "executive";
  const info = db.prepare("INSERT INTO users (name, email, password_hash, role, rate_per_km, vehicle, created_at) VALUES (?,?,?,?,?,?,?)")
    .run(name, email, bcrypt.hashSync(password, 10), role, money(req.body.ratePerKm), str(req.body.vehicle, 40), Date.now());
  res.json({ user: publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(Number(info.lastInsertRowid))) });
});
app.patch("/api/users/:id", auth, adminOnly, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(Number(req.params.id));
  if (!u) return res.status(404).json({ error: "User not found." });
  const b = req.body;
  if (b.active === false && u.id === req.user.id) return res.status(400).json({ error: "You cannot deactivate your own account." });
  if (b.password != null) {
    if (String(b.password).length < 8) return res.status(400).json({ error: "Password needs at least 8 characters." });
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(bcrypt.hashSync(String(b.password), 10), u.id);
  }
  let active = b.active != null ? (b.active ? 1 : 0) : u.active, pending = u.pending;
  if (b.approve) { active = 1; pending = 0; }
  db.prepare("UPDATE users SET name = ?, vehicle = ?, rate_per_km = ?, active = ?, pending = ? WHERE id = ?").run(
    b.name != null ? str(b.name, 80) || u.name : u.name,
    b.vehicle != null ? str(b.vehicle, 40) : u.vehicle,
    b.ratePerKm != null ? money(b.ratePerKm) : u.rate_per_km, active, pending, u.id);
  res.json({ user: publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(u.id)) });
});
app.delete("/api/users/:id", auth, adminOnly, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(Number(req.params.id));
  if (!u || !u.pending) return res.status(400).json({ error: "Only a waiting registration can be removed. Deactivate other accounts instead." });
  db.prepare("DELETE FROM users WHERE id = ?").run(u.id);
  res.json({ ok: true });
});
/* ---------- stops (toll, parking...) ---------- */
app.get("/api/stops/today", auth, execOnly, (req, res) => {
  const [a, b] = dayRange(tzOf(req.query.tz));
  const rows = db.prepare("SELECT st.*, u.name AS user_name FROM stops st JOIN users u ON u.id = st.user_id WHERE st.user_id = ? AND st.start_at >= ? AND st.start_at < ? AND st.kind != 'visit' ORDER BY st.start_at DESC").all(req.user.id, a, b);
  res.json({ stops: rows.map(stopDto) });
});
app.post("/api/stops/:id", auth, execOnly, (req, res) => {
  const st = db.prepare("SELECT * FROM stops WHERE id = ? AND user_id = ?").get(Number(req.params.id), req.user.id);
  if (!st) return res.status(404).json({ error: "Stop not found." });
  const kind = String(req.body.kind || "");
  if (!["toll", "parking", "visit", "other"].includes(kind)) return res.status(400).json({ error: "Choose what this stop was." });
  const amount = req.body.amount === "" || req.body.amount == null ? 0 : Number(req.body.amount);
  if (!Number.isFinite(amount) || amount < 0 || amount > 100000) return res.status(400).json({ error: "Enter a valid amount." });
  if (Date.now() - st.end_at > 48 * 3600000) return res.status(400).json({ error: "This stop is too old to change. Ask the admin." });
  db.prepare("UPDATE stops SET kind = ?, amount = ?, note = ? WHERE id = ?").run(kind, kind === "visit" ? 0 : round2(amount), str(req.body.note, 120), st.id);
  res.json({ ok: true });
});
// costs of a visit that was checked out automatically
app.post("/api/visits/:id/costs", auth, execOnly, (req, res) => {
  const v = db.prepare("SELECT * FROM visits WHERE id = ? AND user_id = ?").get(Number(req.params.id), req.user.id);
  if (!v || v.out_at == null) return res.status(404).json({ error: "Visit not found." });
  if (Date.now() - v.out_at > 48 * 3600000) return res.status(400).json({ error: "This visit is too old to change. Ask the admin." });
  const vals = [];
  for (const k of ["toll", "parking", "other"]) {
    const n = req.body[k] === "" || req.body[k] == null ? 0 : Number(req.body[k]);
    if (!Number.isFinite(n) || n < 0 || n > 100000) return res.status(400).json({ error: "Enter valid amounts." });
    vals.push(round2(n));
  }
  db.prepare("UPDATE visits SET toll = ?, parking = ?, other = ? WHERE id = ?").run(...vals, v.id);
  res.json({ visit: visitDto(db.prepare(VISIT_SQL + " WHERE v.id = ?").get(v.id)) });
});

/* ---------- admin alerts and pop-ups ---------- */
app.get("/api/push/key", auth, adminOnly, (req, res) => res.json({ key: VAPID_PUBLIC }));
app.post("/api/push/subscribe", auth, adminOnly, (req, res) => {
  const sub = req.body.subscription || {};
  const k = sub.keys || {};
  if (typeof sub.endpoint !== "string" || !/^https:\/\//.test(sub.endpoint) || sub.endpoint.length > 1000 || typeof k.p256dh !== "string" || typeof k.auth !== "string") {
    return res.status(400).json({ error: "Invalid subscription." });
  }
  db.prepare("INSERT INTO push_subs (user_id, endpoint, p256dh, auth, created_at) VALUES (?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth")
    .run(req.user.id, sub.endpoint, k.p256dh, k.auth, Date.now());
  res.json({ ok: true });
});
app.post("/api/push/unsubscribe", auth, adminOnly, (req, res) => {
  if (typeof req.body.endpoint === "string") db.prepare("DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?").run(req.body.endpoint, req.user.id);
  res.json({ ok: true });
});
app.post("/api/push/test", auth, adminOnly, (req, res) => {
  notify("test", "Test alert", "Pop-ups are working. You will see alerts like this when executives sign in or stop.", null);
  res.json({ ok: true });
});
app.get("/api/notifications", auth, adminOnly, (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const items = db.prepare("SELECT * FROM notifications ORDER BY id DESC LIMIT ?").all(limit);
  const seen = db.prepare("SELECT notif_seen FROM users WHERE id = ?").get(req.user.id).notif_seen;
  const unread = db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE id > ?").get(seen).n;
  res.json({ items: items.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, at: n.created_at, unread: n.id > seen })), unread,
    subscribed: db.prepare("SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?").get(req.user.id).n > 0 });
});
app.post("/api/notifications/read", auth, adminOnly, (req, res) => {
  const max = db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM notifications").get().m;
  db.prepare("UPDATE users SET notif_seen = ? WHERE id = ?").run(max, req.user.id);
  res.json({ ok: true });
});

app.get("/api/settings", auth, adminOnly, (req, res) => res.json({ settings: getSettings() }));
app.put("/api/settings", auth, adminOnly, (req, res) => {
  const ins = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  for (const k of Object.keys(DEFAULTS)) {
    if (req.body[k] == null) continue;
    const n = Number(req.body[k]);
    if (!Number.isFinite(n) || n < 0 || n > 100000) return res.status(400).json({ error: "Invalid value for " + k + "." });
    ins.run(k, String(n));
  }
  res.json({ settings: getSettings() });
});
// admin can correct the km of a shift, with a written reason
app.patch("/api/shifts/:id", auth, adminOnly, (req, res) => {
  const s = db.prepare("SELECT * FROM shifts WHERE id = ?").get(Number(req.params.id));
  if (!s) return res.status(404).json({ error: "Shift not found." });
  if (req.body.km === "" || req.body.km === null) {
    db.prepare("UPDATE shifts SET admin_km = NULL, admin_note = '' WHERE id = ?").run(s.id);
  } else {
    const km = Number(req.body.km), note = str(req.body.note, 200);
    if (!Number.isFinite(km) || km < 0 || km > 5000) return res.status(400).json({ error: "Enter the km to claim for this shift." });
    if (!note) return res.status(400).json({ error: "Give a reason for the change." });
    db.prepare("UPDATE shifts SET admin_km = ?, admin_note = ? WHERE id = ?").run(round1(km), note + " (" + req.user.name + ")", s.id);
  }
  res.json({ shift: shiftDto(db.prepare(SHIFT_SQL + " WHERE s.id = ?").get(s.id), getSettings()) });
});

app.use(express.static(path.join(__dirname, "public")));
app.use((req, res) => res.status(404).json({ error: "Not found." }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: "Something went wrong." }); });

app.listen(PORT, () => console.log("KM Tracker running on http://localhost:" + PORT));
