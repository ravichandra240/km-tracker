(function () {
  "use strict";
  var app = document.getElementById("app");
  var TZ = new Date().getTimezoneOffset();
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  var inr = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var km1 = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  var S = { me: null, tab: null, month: ym(new Date()), reportUser: "all", result: null, timer: null, map: null, layer: null, mapDate: null, mapFocus: null };

  function ym(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); }
  function todayStr() { var d = new Date(); return ym(d) + "-" + String(d.getDate()).padStart(2, "0"); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function rs(n) { return "₹" + inr.format(Number(n) || 0); }
  function hm(t) { return t == null ? "—" : new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  function dm(t) { return new Date(t).toLocaleDateString([], { day: "numeric", month: "short" }); }
  function mins(m) { if (m == null) return "—"; m = Math.round(m); return m >= 60 ? Math.floor(m / 60) + " h " + (m % 60) + " m" : m + " m"; }
  function hrs(h) { return mins(h * 60); }
  function ago(t, now) { var m = Math.max(0, Math.round((now - t) / 60000)); return m < 1 ? "just now" : m < 60 ? m + " min ago" : Math.floor(m / 60) + " h " + (m % 60) + " min ago"; }
  function $(id) { return document.getElementById(id); }
  function say(id, text, cls) { var el = $(id); if (el) { el.textContent = text; el.className = cls || "hint"; el.hidden = !text; } }

  function api(path, method, body) {
    var opts = { method: method || "GET", credentials: "same-origin", headers: {} };
    if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || "Request failed."); e.status = r.status; throw e; }
        return j;
      });
    });
  }
  function position() {
    return new Promise(function (resolve, reject) {
      // use the tracker's reading when it is fresh: instant, and no second GPS request
      if (T.last && Date.now() - T.last.t < 20000 && (T.last.accuracy == null || T.last.accuracy < 150)) return resolve({ lat: T.last.lat, lng: T.last.lng, accuracy: T.last.accuracy });
      if (!navigator.geolocation) return reject(new Error("This browser cannot share location."));
      navigator.geolocation.getCurrentPosition(function (p) {
        resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy });
      }, function (e) {
        reject(new Error(e.code === 1 ? "Location is blocked. Allow location for this site in your browser settings." : "Could not get your location. Move to an open area and try again."));
      }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    });
  }

  /* =====================================================================
     Live tracking: runs from login until logout, for executives
     ===================================================================== */
  var T = { last: null, watch: null, buf: [], lastPush: 0, lastSend: 0, timer: null, sending: false, state: "idle", offset: 0, todayKm: 0, todayAllowance: 0, shift: null, lastFix: 0, online: true, wake: null, acc: null };

  function tStart() {
    if (T.watch !== null || T.timer !== null) return;
    if (!navigator.geolocation) { T.state = "unsupported"; paintBar(); return; }
    T.state = "starting";
    api("/api/shift/current?tz=" + TZ).then(applyInfo).catch(onTrackError);
    T.watch = navigator.geolocation.watchPosition(onFix, onGeoErr, { enableHighAccuracy: true, maximumAge: 3000, timeout: 30000 });
    T.timer = setInterval(tick, 5000);
    document.addEventListener("visibilitychange", onVis);
    wake();
    paintBar();
  }
  function tStop() {
    if (T.watch !== null) { navigator.geolocation.clearWatch(T.watch); T.watch = null; }
    clearInterval(T.timer); T.timer = null;
    document.removeEventListener("visibilitychange", onVis);
    if (T.wake) { try { T.wake.release(); } catch (e) {} T.wake = null; }
    T.buf = []; T.state = "idle"; T.shift = null; T.last = null; T.todayKm = 0; T.todayAllowance = 0;
  }
  function wake() {
    if (!("wakeLock" in navigator)) return;
    navigator.wakeLock.request("screen").then(function (l) { T.wake = l; l.addEventListener("release", function () { T.wake = null; }); }).catch(function () {});
  }
  function onVis() { if (!document.hidden) { if (!T.wake) wake(); flush(); } }
  function onFix(p) {
    T.state = "tracking"; T.lastFix = Date.now(); T.acc = p.coords.accuracy;
    T.last = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, t: Date.now() };
    var now = Date.now();
    if (now - T.lastPush >= 10000) {
      T.lastPush = now;
      T.buf.push({ t: now + T.offset, lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy });
      if (T.buf.length > 600) T.buf.shift();
    }
    paintBar();
  }
  function onGeoErr(e) { T.state = e.code === 1 ? "denied" : "searching"; paintBar(); }
  function tick() {
    var idle = Date.now() - T.lastFix;
    if (T.state !== "denied" && idle > 25000 && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(onFix, onGeoErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
    }
    if (T.state === "tracking" && idle > 60000) T.state = "searching";
    if (Date.now() - T.lastSend >= 15000 || T.buf.length >= 6) flush();
    paintBar();
  }
  function flush() {
    if (T.sending || T.state === "idle" || T.state === "denied" || T.state === "unsupported") return;
    if (!T.buf.length && T.state !== "tracking") return;
    var batch = T.buf.slice(0, 50);
    T.sending = true; T.lastSend = Date.now();
    api("/api/track", "POST", { points: batch, tz: TZ }).then(function (j) {
      T.buf = T.buf.slice(batch.length); T.online = true; applyInfo(j);
    }).catch(onTrackError).then(function () { T.sending = false; paintBar(); });
  }
  function onTrackError(e) {
    if (e && e.status === 401) { tStop(); S.me = null; renderLogin("Your session ended. Sign in again."); }
    else T.online = false;
  }
  function applyInfo(j) {
    T.shift = j.shift; T.todayKm = j.todayKm; T.todayAllowance = j.todayAllowance;
    if (j.serverNow) T.offset = j.serverNow - Date.now();
    T.online = true;
    paintBar(); paintToday();
  }
  function paintBar() {
    var el = $("trackbar");
    if (!el) return;
    var cls = "trackbar", msg = "";
    if (T.state === "denied") { cls += " bad"; msg = "Location is blocked, so your km are not being recorded. Allow location for this site in the browser settings, then reload."; }
    else if (T.state === "unsupported") { cls += " bad"; msg = "This browser cannot share location. Use Chrome on your phone."; }
    else if (!T.online) { cls += " warn"; msg = "No connection. Readings are saved on this phone and will be sent when you are back online."; }
    else if (T.state === "tracking") { cls += " on"; msg = "Tracking on · " + km1.format(T.todayKm) + " km today · " + rs(T.todayAllowance) + ". Keep this page open."; }
    else { cls += " warn"; msg = "Waiting for GPS signal. Move to an open area."; }
    el.className = cls;
    el.querySelector(".msg").textContent = msg;
  }
  function paintToday() {
    var s = T.shift;
    if (!$("tKm") || !s) return;
    $("tKm").textContent = km1.format(T.todayKm);
    $("tAllow").textContent = rs(T.todayAllowance);
    $("tSince").textContent = "Logged in at " + hm(s.startAt) + " · " + hrs(s.hours);
    var f = $("tFlags");
    f.innerHTML = s.flags.length ? s.flags.map(function (x) { return '<span class="chip warn">' + esc(x.text) + (x.count > 1 ? " ×" + x.count : "") + "</span>"; }).join("") : "";
  }

  /* ---------- login and registration ---------- */
  function renderLogin(note, kind, mode) {
    clearInterval(S.timer);
    mode = mode || "login";
    var reg = mode === "register";
    app.innerHTML =
      '<div class="card login"><div class="brand"><h1>KM Tracker</h1><div class="muted">' +
      (reg ? "Create your account. An admin approves it before you can sign in." : "Sign in to start your day. Your km are recorded from sign in to sign out.") + "</div></div>" +
      '<form id="authForm" class="stack" novalidate>' +
      (reg ? '<label class="field"><span>Full name</span><input class="in" id="aName" autocomplete="name" required></label>' : "") +
      '<label class="field"><span>Email</span><input class="in" id="aEmail" type="email" autocomplete="username" required></label>' +
      (reg ? '<label class="field"><span>Vehicle (Bike, Car)</span><input class="in" id="aVeh"></label>' : "") +
      '<label class="field"><span>Password' + (reg ? " (8+ characters)" : "") + '</span><input class="in" id="aPass" type="password" autocomplete="' + (reg ? "new-password" : "current-password") + '" required></label>' +
      '<div class="' + (kind === "ok" ? "ok" : "err") + '" id="aMsg" role="alert"' + (note ? "" : " hidden") + ">" + esc(note || "") + "</div>" +
      '<button class="btn primary big" type="submit">' + (reg ? "Register" : "Sign in") + "</button></form>" +
      '<button class="btn link" id="swap" type="button">' + (reg ? "I already have an account" : "New executive? Register here") + "</button></div>";
    $("swap").addEventListener("click", function () { renderLogin("", "", reg ? "login" : "register"); });
    $("authForm").addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (reg) {
        api("/api/register", "POST", { name: $("aName").value, email: $("aEmail").value, vehicle: $("aVeh").value, password: $("aPass").value })
          .then(function () { renderLogin("Registered. Wait for your admin to approve the account, then sign in.", "ok", "login"); })
          .catch(function (e) { say("aMsg", e.message, "err"); });
      } else {
        api("/api/login", "POST", { email: $("aEmail").value, password: $("aPass").value }).then(boot).catch(function (e) { say("aMsg", e.message, "err"); });
      }
    });
  }

  /* ---------- shell ---------- */
  function tabsFor() {
    return S.me.role === "admin"
      ? [["map", "Map"], ["report", "Report"], ["team", "Team"], ["rules", "Rules"], ["account", "Account"]]
      : [["today", "Today"], ["report", "Report"], ["account", "Account"]];
  }
  function renderShell() {
    var tabs = tabsFor(), isExec = S.me.role === "executive";
    if (!tabs.some(function (t) { return t[0] === S.tab; })) S.tab = tabs[0][0];
    app.innerHTML =
      '<div class="bar"><div><h1>KM Tracker</h1><div class="muted">' + esc(S.me.name) + " · " + (isExec ? "Executive" : "Admin") + "</div></div>" +
      '<div class="bar"><div class="tabs" role="tablist">' + tabs.map(function (t) {
        return '<button class="tab" role="tab" data-tab="' + t[0] + '" aria-selected="' + (t[0] === S.tab) + '">' + t[1] + "</button>";
      }).join("") + '</div><button class="btn" id="logout" type="button">Sign out</button></div></div>' +
      (isExec ? '<div id="trackbar" class="trackbar warn" role="status"><span class="dotl"></span><span class="msg"></span></div>' : "") +
      '<div id="view" class="stack"></div>';
    Array.prototype.forEach.call(app.querySelectorAll("[data-tab]"), function (b) {
      b.addEventListener("click", function () { S.tab = b.dataset.tab; S.result = null; renderShell(); });
    });
    $("logout").addEventListener("click", doLogout);
    clearInterval(S.timer);
    if (S.map) { S.map.remove(); S.map = null; }
    paintBar();
    ({ today: viewToday, map: viewMap, report: viewReport, team: viewTeam, rules: viewRules, account: viewAccount })[S.tab]();
  }
  function doLogout() {
    var b = $("logout"); b.disabled = true;
    var finish = function () { api("/api/logout", "POST", {}).catch(function () {}).then(function () { tStop(); S.me = null; S.tab = null; renderLogin(); }); };
    if (S.me.role === "executive" && (T.buf.length || T.state === "tracking")) {
      api("/api/track", "POST", { points: T.buf.slice(0, 100), tz: TZ }).catch(function () {}).then(finish);
    } else finish();
  }
  function handleAuth(e) {
    if (e && e.status === 401) { tStop(); S.me = null; renderLogin("Your session ended. Sign in again."); }
    else { var v = $("view"); if (v) v.innerHTML = '<div class="card"><div class="err">' + esc(e && e.message) + "</div></div>"; }
  }

  /* ---------- today (executive) ---------- */
  function flagChips(v) {
    var c = v.counted ? '<span class="chip good">Distance OK</span>' : '<span class="chip bad">Check needed</span>';
    return c + v.flags.map(function (f) { return '<span class="chip warn">' + esc(f.text) + "</span>"; }).join("");
  }
  function visitResult(v) {
    var rows = [["Came from " + esc(v.legFrom || "start point") + " (distance check only)", km1.format(v.legKm) + " km"], ["Toll", rs(v.toll)], ["Parking", rs(v.parking)], ["Other", rs(v.other)]];
    return '<div class="calc">' + rows.map(function (l) { return '<div class="line"><span>' + l[0] + '</span><span class="v">' + l[1] + "</span></div>"; }).join("") +
      '<div class="line total"><span>Costs added to this month</span><span class="v">' + rs(v.costs) + "</span></div></div>";
  }
  function viewToday() {
    var el = $("view");
    el.innerHTML = '<div class="card"><div class="muted">Loading…</div></div>';
    Promise.all([api("/api/visits/open"), api("/api/visits/today?tz=" + TZ)]).then(function (r) {
      var open = r[0].visit, today = r[1].visits;
      var html = '<div class="card"><header><h2>Your day</h2><span class="hint" id="tSince"></span></header>' +
        '<div class="bignums"><div><div class="big num" id="tKm">0.0</div><div class="hint">km tracked today</div></div><div><div class="big num" id="tAllow">₹0.00</div><div class="hint">travel allowance</div></div></div>' +
        '<div id="tFlags"></div><div class="hint">Km are recorded from the phone\'s GPS while you are signed in and this page is open. Standing still, weak GPS, impossible speeds and jumps are not counted. Signing out ends the day.</div></div>';
      if (open) {
        html += '<div class="card"><header><h2>Checked in</h2></header>' +
          '<div class="status in"><span class="dot"></span><div><b>' + esc(open.place) + "</b><br><span>Since " + hm(open.inAt) + (open.purpose ? " · " + esc(open.purpose) : "") + "</span></div></div>" +
          '<div class="clock" id="clock">00:00:00</div>' +
          '<form id="outForm" class="stack" novalidate><div class="row3">' +
          '<label class="field"><span>Toll (₹)</span><input class="in num" id="oToll" type="number" inputmode="decimal" min="0" step="1"></label>' +
          '<label class="field"><span>Parking (₹)</span><input class="in num" id="oPark" type="number" inputmode="decimal" min="0" step="1"></label>' +
          '<label class="field"><span>Other (₹)</span><input class="in num" id="oOther" type="number" inputmode="decimal" min="0" step="1"></label></div>' +
          '<label class="field"><span>Note (optional)</span><input class="in" id="oNote" maxlength="300"></label>' +
          '<div class="err" id="vErr" role="alert" hidden></div><button class="btn big out" type="submit" id="outBtn">Check out</button></form></div>';
      } else {
        html += '<div class="card"><header><h2>Check in at a place</h2></header>';
        if (S.result) html += '<div class="stack"><div class="status ' + (S.result.counted ? "in" : "") + '"><div><b>Last visit: ' + esc(S.result.place) + "</b><br>" + flagChips(S.result) + "</div></div>" + visitResult(S.result) + "</div>";
        if (S.me.baseLat == null) html += '<div class="status"><div>No start point saved. Open <b>Account</b> and tap "Use my location as start point" so the first visit of the day can be checked.</div></div>';
        html += '<form id="inForm" class="stack" novalidate>' +
          '<label class="field"><span>Place you are visiting</span><input class="in" id="iPlace" maxlength="120" placeholder="Client name or address" autocomplete="off" required></label>' +
          '<label class="field"><span>Purpose</span><input class="in" id="iPurpose" maxlength="200" placeholder="Dealer visit, collection, audit" autocomplete="off"></label>' +
          '<div class="err" id="vErr" role="alert" hidden></div><button class="btn big primary" type="submit" id="inBtn">Check in here</button></form></div>';
      }
      html += '<div class="card"><header><h2>Visits today</h2><span class="hint">' + today.length + " visit" + (today.length === 1 ? "" : "s") + "</span></header>" +
        (today.length ? '<div class="scroll"><table><thead><tr><th>Place</th><th>Time</th><th class="r">Costs</th></tr></thead><tbody>' + today.map(function (v) {
          return "<tr><td>" + esc(v.place) + "<small>" + esc(v.purpose) + "</small>" + (v.open ? '<span class="chip good">In progress</span>' : flagChips(v)) + "</td><td>" + hm(v.inAt) + "–" + hm(v.outAt) + "<small>" + mins(v.stayMin) + '</small></td><td class="r">' + rs(v.costs) + "</td></tr>";
        }).join("") + "</tbody></table></div>" : '<div class="empty">No visits yet today.</div>') + "</div>";
      el.innerHTML = html;
      paintToday();
      if (open) {
        var tickClock = function () {
          var s = Math.max(0, Math.floor((Date.now() + T.offset - open.inAt) / 1000));
          var c = $("clock"); if (c) c.textContent = [Math.floor(s / 3600), Math.floor(s % 3600 / 60), s % 60].map(function (n) { return String(n).padStart(2, "0"); }).join(":");
        };
        tickClock(); S.timer = setInterval(tickClock, 1000);
        $("outForm").addEventListener("submit", function (ev) {
          ev.preventDefault();
          var b = $("outBtn"); b.disabled = true; b.textContent = "Getting your location…"; say("vErr", "");
          position().then(function (p) {
            return api("/api/checkout", "POST", { lat: p.lat, lng: p.lng, accuracy: p.accuracy, toll: $("oToll").value, parking: $("oPark").value, other: $("oOther").value, note: $("oNote").value });
          }).then(function (j) { S.result = j.visit; viewToday(); })
            .catch(function (e) { if (e.status === 401) return handleAuth(e); say("vErr", e.message, "err"); b.disabled = false; b.textContent = "Check out"; });
        });
      } else {
        $("inForm").addEventListener("submit", function (ev) {
          ev.preventDefault();
          var b = $("inBtn"); b.disabled = true; b.textContent = "Getting your location…"; say("vErr", "");
          position().then(function (p) {
            return api("/api/checkin", "POST", { place: $("iPlace").value, purpose: $("iPurpose").value, lat: p.lat, lng: p.lng, accuracy: p.accuracy });
          }).then(function () { S.result = null; viewToday(); })
            .catch(function (e) { if (e.status === 401) return handleAuth(e); say("vErr", e.message, "err"); b.disabled = false; b.textContent = "Check in here"; });
        });
      }
    }).catch(handleAuth);
  }

  /* ---------- live map (admin) ---------- */
  var COLORS = ["#0A6B63", "#B3261E", "#7A3FB5", "#C47A00", "#1F5FBF", "#C2185B", "#2E7D32", "#5D4037", "#00838F", "#6A6A6A"];
  function pinIcon(text, color, cls) {
    return L.divIcon({ className: "", html: '<div class="pin ' + (cls || "") + '" style="background:' + color + '">' + esc(text) + "</div>", iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -14] });
  }
  function viewMap() {
    var el = $("view");
    S.mapDate = S.mapDate || todayStr();
    el.innerHTML = '<div class="card"><div class="bar"><div class="field"><span>Date</span><input class="in" type="date" id="mDate" value="' + S.mapDate + '" max="' + todayStr() + '"></div>' +
      '<div class="hint" id="mStamp">Loading…</div></div>' +
      '<div class="mapwrap"><div class="elist" id="elist"></div><div id="map" role="application" aria-label="Map of executives"></div></div>' +
      '<div class="hint">Executives who are signed in with the page open send their position every 15 seconds. The line is the path they travelled. Numbered pins are check-in places; faded pins failed a distance check. The map refreshes every 10 seconds.</div></div>';
    S.map = L.map("map").setView([20.59, 78.96], 5);
    L.tileLayer(S.tileUrl || "https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, referrerPolicy: "origin", attribution: "&copy; OpenStreetMap contributors" }).addTo(S.map);
    S.layer = L.layerGroup().addTo(S.map);
    $("mDate").addEventListener("change", function () { S.mapDate = this.value || todayStr(); S.mapFocus = null; loadMap(true); });
    loadMap(true);
    S.timer = setInterval(function () { if (S.mapDate === todayStr()) loadMap(false); }, 10000);
  }
  function loadMap(fit) {
    api("/api/live?date=" + S.mapDate + "&tz=" + TZ).then(function (d) {
      if (!S.map) return;
      var execs = d.executives;
      $("mStamp").textContent = "Updated " + new Date(d.now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      $("elist").innerHTML = execs.length ? execs.map(function (x, i) {
        var chip = x.state === "live" ? '<span class="chip good">Live</span>' : x.state === "stale" ? '<span class="chip warn">Signal lost</span>' : '<span class="chip">Signed out</span>';
        var seen = x.lastSeenAt ? "Last seen " + ago(x.lastSeenAt, d.now) : "No tracking this day";
        return '<button type="button" class="eitem" data-e="' + x.id + '" aria-pressed="' + (S.mapFocus === x.id) + '"><b><span class="swatch" style="background:' + COLORS[i % COLORS.length] + '"></span>' + esc(x.name) + " " + chip + "</b>" +
          "<small>" + seen + "</small><small>" + km1.format(x.km) + " km · " + hrs(x.hours) + " · " + rs(x.allowance) + "</small>" +
          "<small>" + x.visits.length + " visit" + (x.visits.length === 1 ? "" : "s") + (x.flags ? " · " + x.flags + " check" + (x.flags === 1 ? "" : "s") : "") + "</small></button>";
      }).join("") : '<div class="empty">No executives yet. Approve registrations under Team.</div>';
      Array.prototype.forEach.call(document.querySelectorAll(".eitem"), function (b) {
        b.addEventListener("click", function () { var id = Number(b.dataset.e); S.mapFocus = S.mapFocus === id ? null : id; loadMap(true); });
      });
      S.layer.clearLayers();
      var bounds = [];
      execs.forEach(function (x, i) {
        if (S.mapFocus && S.mapFocus !== x.id) return;
        var color = COLORS[i % COLORS.length];
        if (x.base) {
          bounds.push([x.base.lat, x.base.lng]);
          L.marker([x.base.lat, x.base.lng], { icon: pinIcon("S", color, "home"), title: x.name + " start point" }).addTo(S.layer).bindPopup("<b>" + esc(x.name) + "</b><br>Start point: " + esc(x.base.name));
        }
        if (x.trail.length > 1) { L.polyline(x.trail, { color: color, weight: 4, opacity: .8 }).addTo(S.layer); x.trail.forEach(function (p) { bounds.push(p); }); }
        x.visits.forEach(function (v, n) {
          var p = [v.inLat, v.inLng]; bounds.push(p);
          var pop = "<b>" + esc(x.name) + "</b><br>" + (n + 1) + ". " + esc(v.place) + (v.purpose ? "<br>" + esc(v.purpose) : "") +
            "<br>In " + hm(v.inAt) + (v.open ? " · still here" : " · out " + hm(v.outAt) + " · stayed " + mins(v.stayMin) + "<br>Costs " + rs(v.costs)) +
            (v.flags.length ? "<br><i>" + v.flags.map(function (f) { return esc(f.text); }).join("<br>") + "</i>" : "");
          L.marker(p, { icon: pinIcon(String(n + 1), color, v.counted || v.open ? "visit" : "visit skip"), title: v.place }).addTo(S.layer).bindPopup(pop);
        });
        if (x.pos) {
          bounds.push([x.pos.lat, x.pos.lng]);
          L.marker([x.pos.lat, x.pos.lng], { icon: pinIcon(x.name.charAt(0).toUpperCase(), color, "cur" + (x.state === "live" ? " live" : "")), zIndexOffset: 1000, title: x.name }).addTo(S.layer)
            .bindPopup("<b>" + esc(x.name) + "</b><br>" + (x.state === "live" ? "Live now" : x.lastSeenAt ? "Last seen " + ago(x.lastSeenAt, d.now) : "") + "<br>" + km1.format(x.km) + " km today" + (x.pos.acc ? "<br>GPS accuracy " + Math.round(x.pos.acc) + " m" : ""));
        }
      });
      if (fit) {
        if (bounds.length > 1) S.map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
        else if (bounds.length === 1) S.map.setView(bounds[0], 14);
      }
    }).catch(handleAuth);
  }

  /* ---------- report ---------- */
  function shiftMonth(d) {
    var p = S.month.split("-"), y = +p[0], m = +p[1] - 1 + d;
    y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
    S.month = y + "-" + String(m + 1).padStart(2, "0");
  }
  function chipsOf(flags) {
    return flags.length ? flags.map(function (f) { return '<span class="chip warn">' + esc(f.text) + (f.count > 1 ? " ×" + f.count : "") + "</span>"; }).join("") : '<span class="chip good">Clean</span>';
  }
  function viewReport() {
    var el = $("view"), isAdmin = S.me.role === "admin";
    var usersP = isAdmin ? api("/api/users") : Promise.resolve({ users: [] });
    usersP.then(function (u) {
      var q = "month=" + S.month + "&tz=" + TZ + (isAdmin ? "&user=" + encodeURIComponent(S.reportUser) : "");
      return api("/api/report?" + q).then(function (d) { return { d: d, users: u.users, q: q }; });
    }).then(function (x) {
      var d = x.d, p = S.month.split("-"), t = d.totals;
      var picker = isAdmin ? '<label class="field" style="min-width:180px"><span>Executive</span><select class="in" id="rUser"><option value="all">All executives</option>' +
        x.users.filter(function (u) { return u.role === "executive" && !u.pending; }).map(function (u) { return '<option value="' + u.id + '"' + (String(u.id) === S.reportUser ? " selected" : "") + ">" + esc(u.name) + "</option>"; }).join("") + "</select></label>" : "";
      var dl = function (type, label) { return '<a class="btn" style="text-decoration:none;display:inline-flex;align-items:center" href="/api/report.csv?' + x.q + "&type=" + type + '">' + label + "</a>"; };
      var html = '<div class="card"><div class="bar"><div class="monthnav"><button class="btn sq" id="mPrev" aria-label="Previous month">&lsaquo;</button><div class="label">' + MONTHS[+p[1] - 1].slice(0, 3) + " " + p[0] +
        '</div><button class="btn sq" id="mNext" aria-label="Next month">&rsaquo;</button></div><div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">' + picker + dl("summary", "Download summary") + dl("shifts", "Download days") + dl("visits", "Download visits") + "</div></div>" +
        '<div class="calc">' +
        '<div class="line"><span>Days signed in</span><span class="v">' + t.shifts + " (" + hrs(t.hours) + ")</span></div>" +
        '<div class="line"><span>Km from live tracking</span><span class="v">' + km1.format(t.km) + " km</span></div>" +
        '<div class="line"><span>Travel allowance</span><span class="v">' + rs(t.allowance) + "</span></div>" +
        '<div class="line"><span>Toll, parking, other (' + t.visits + ' visits)</span><span class="v">' + rs(t.costs) + "</span></div>" +
        '<div class="line total"><span>Total claim for the month</span><span class="v">' + rs(t.total) + "</span></div></div></div>";

      if (isAdmin && d.byUser.length > 1) {
        html += '<div class="card"><header><h2>By executive</h2></header><div class="scroll"><table><thead><tr><th>Executive</th><th class="r">Days</th><th class="r">Hours</th><th class="r">Km</th><th class="r">Allowance</th><th class="r">Costs</th><th class="r">Total</th></tr></thead><tbody>' +
          d.byUser.map(function (u) { return "<tr><td>" + esc(u.name) + '</td><td class="r">' + u.shifts + '</td><td class="r">' + u.hours + '</td><td class="r">' + km1.format(u.km) + '</td><td class="r">' + rs(u.allowance) + '</td><td class="r">' + rs(u.costs) + '</td><td class="r"><b>' + rs(u.total) + "</b></td></tr>"; }).join("") + "</tbody></table></div></div>";
      }

      var cols = isAdmin ? 11 : 10;
      html += '<div class="card"><header><h2>Days signed in</h2></header><div class="scroll"><table><thead><tr>' + (isAdmin ? "<th>Executive</th>" : "") +
        '<th>Date</th><th>Login – logout</th><th class="r">Hours</th><th class="r">Tracked km</th><th class="r">Not counted</th><th class="r">Km claimed</th><th class="r">Rate</th><th class="r">Allowance</th><th>Checks</th>' + (isAdmin ? "<th></th>" : "") + "</tr></thead><tbody>";
      if (!d.shifts.length) html += '<tr><td colspan="' + cols + '" class="empty">No days recorded in this month.</td></tr>';
      d.shifts.forEach(function (s) {
        html += "<tr>" + (isAdmin ? "<td>" + esc(s.userName) + "</td>" : "") + "<td>" + dm(s.startAt) + "</td><td>" + hm(s.startAt) + " – " + (s.open ? "now" : hm(s.endAt)) +
          (s.endedBy === "timeout" ? "<small>Signal stopped</small>" : "") + '</td><td class="r">' + hrs(s.hours) + '</td><td class="r">' + km1.format(s.trackedKm) + '</td><td class="r">' + km1.format(s.ignoredKm) +
          '</td><td class="r"><b>' + km1.format(s.km) + "</b>" + (s.adminKm != null ? "<small>Adjusted by admin</small>" : "") + '</td><td class="r">' + rs(s.rate) + '</td><td class="r"><b>' + rs(s.allowance) + "</b></td><td>" + chipsOf(s.flags) +
          (s.adminNote ? "<small>" + esc(s.adminNote) + "</small>" : "") + "</td>" + (isAdmin ? '<td><button class="btn link" data-review="' + s.id + '" type="button">Adjust</button></td>' : "") + "</tr>";
        if (isAdmin) {
          html += '<tr hidden data-rrow="' + s.id + '"><td colspan="' + cols + '"><div class="stack" style="max-width:520px"><div class="row2"><label class="field"><span>Km to claim</span><input class="in num" id="rk' + s.id + '" type="number" min="0" step="0.1" value="' + s.km + '"></label>' +
            '<label class="field"><span>Reason</span><input class="in" id="rr' + s.id + '" maxlength="200"></label></div>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" data-set="' + s.id + '" type="button">Save</button>' + (s.adminKm != null ? '<button class="btn" data-clear="' + s.id + '" type="button">Back to tracked km</button>' : "") + '</div><div class="err" id="re' + s.id + '" hidden></div></div></td></tr>';
        }
      });
      html += "</tbody>" + (d.shifts.length ? '<tfoot><tr><td colspan="' + (isAdmin ? 3 : 2) + '">Total</td><td class="r">' + hrs(t.hours) + '</td><td colspan="2"></td><td class="r">' + km1.format(t.km) + '</td><td></td><td class="r">' + rs(t.allowance) + "</td><td></td>" + (isAdmin ? "<td></td>" : "") + "</tr></tfoot>" : "") + "</table></div></div>";

      html += '<div class="card"><header><h2>Check-in and check-out visits</h2></header><div class="scroll"><table><thead><tr>' + (isAdmin ? "<th>Executive</th>" : "") +
        '<th>Place</th><th>Check in / out</th><th class="r">Stay</th><th class="r">Km from last place</th><th class="r">Toll</th><th class="r">Parking</th><th class="r">Other</th><th class="r">Costs</th><th>Distance check</th></tr></thead><tbody>';
      if (!d.visits.length) html += '<tr><td colspan="' + (isAdmin ? 10 : 9) + '" class="empty">No completed visits in this month.</td></tr>';
      d.visits.forEach(function (v) {
        html += "<tr>" + (isAdmin ? "<td>" + esc(v.userName) + "</td>" : "") + "<td>" + esc(v.place) + "<small>" + esc(v.purpose) + "</small></td><td>" + dm(v.inAt) + " " + hm(v.inAt) + "<small>to " + hm(v.outAt) + '</small></td><td class="r">' + mins(v.stayMin) +
          '</td><td class="r">' + km1.format(v.legKm) + '</td><td class="r">' + rs(v.toll) + '</td><td class="r">' + rs(v.parking) + '</td><td class="r">' + rs(v.other) + '</td><td class="r"><b>' + rs(v.costs) + "</b></td><td>" + flagChips(v) + "</td></tr>";
      });
      html += "</tbody>" + (d.visits.length ? '<tfoot><tr><td colspan="' + (isAdmin ? 5 : 4) + '">Total</td><td class="r">' + rs(t.toll) + '</td><td class="r">' + rs(t.parking) + '</td><td class="r">' + rs(t.other) + '</td><td class="r">' + rs(t.costs) + "</td><td></td></tr></tfoot>" : "") + "</table></div>" +
        '<div class="hint">Km claimed come from live tracking. The visit distance check compares the places visited and does not change the claim.</div></div>';
      el.innerHTML = html;
      $("mPrev").addEventListener("click", function () { shiftMonth(-1); viewReport(); });
      $("mNext").addEventListener("click", function () { shiftMonth(1); viewReport(); });
      if ($("rUser")) $("rUser").addEventListener("change", function () { S.reportUser = this.value; viewReport(); });
      Array.prototype.forEach.call(el.querySelectorAll("[data-review]"), function (b) {
        b.addEventListener("click", function () { var r = el.querySelector('[data-rrow="' + b.dataset.review + '"]'); r.hidden = !r.hidden; });
      });
      Array.prototype.forEach.call(el.querySelectorAll("[data-set]"), function (b) {
        b.addEventListener("click", function () {
          var id = b.dataset.set;
          api("/api/shifts/" + id, "PATCH", { km: $("rk" + id).value, note: $("rr" + id).value }).then(viewReport).catch(function (e) { say("re" + id, e.message, "err"); });
        });
      });
      Array.prototype.forEach.call(el.querySelectorAll("[data-clear]"), function (b) {
        b.addEventListener("click", function () { api("/api/shifts/" + b.dataset.clear, "PATCH", { km: "" }).then(viewReport).catch(function (e) { say("re" + b.dataset.clear, e.message, "err"); }); });
      });
    }).catch(handleAuth);
  }

  /* ---------- team (admin) ---------- */
  function viewTeam() {
    var el = $("view");
    api("/api/users").then(function (r) {
      var pending = r.users.filter(function (u) { return u.pending; }), people = r.users.filter(function (u) { return !u.pending; });
      var html = "";
      if (pending.length) {
        html += '<div class="card"><header><h2>Waiting for approval</h2><span class="chip warn">' + pending.length + "</span></header><div class=\"stack\">" + pending.map(function (u) {
          return '<div class="grid-users" data-u="' + u.id + '"><div style="grid-column:1/3"><b>' + esc(u.name) + '</b><div class="hint">' + esc(u.email) + (u.vehicle ? " · " + esc(u.vehicle) : "") + "</div></div>" +
            '<label class="field"><span>₹ per km</span><input class="in num" data-f="ratePerKm" type="number" min="0" step="0.5" value="' + u.ratePerKm + '"></label>' +
            '<button class="btn primary" data-approve="' + u.id + '" type="button">Approve</button><button class="btn link danger" data-reject="' + u.id + '" type="button">Reject</button></div>';
        }).join("") + '<div class="err" id="pErr" hidden></div></div></div>';
      }
      html += '<div class="card"><header><h2>Team</h2></header><div class="stack">' + people.map(function (u) {
        return '<div class="grid-users" data-u="' + u.id + '">' +
          '<label class="field"><span>Name</span><input class="in" data-f="name" value="' + esc(u.name) + '"></label>' +
          '<label class="field"><span>Vehicle</span><input class="in" data-f="vehicle" value="' + esc(u.vehicle) + '"></label>' +
          '<label class="field"><span>₹ per km</span><input class="in num" data-f="ratePerKm" type="number" min="0" step="0.5" value="' + u.ratePerKm + '"></label>' +
          '<button class="btn" data-save="' + u.id + '" type="button">Save</button>' +
          '<button class="btn link ' + (u.active ? "danger" : "") + '" data-active="' + u.id + '" data-to="' + (!u.active) + '" type="button">' + (u.active ? "Deactivate" : "Activate") + "</button>" +
          '<div class="hint" style="grid-column:1/-1">' + esc(u.email) + " · " + (u.role === "admin" ? "Admin" : "Executive") + (u.active ? "" : " · Inactive") + "</div></div>";
      }).join("") + '<div class="err" id="tErr" hidden></div><div class="hint">A new rate applies from the person\'s next sign in.</div></div></div>' +
        '<div class="card"><header><h2>Add a person</h2></header><form id="newUser" class="stack" novalidate><div class="row2">' +
        '<label class="field"><span>Name</span><input class="in" id="nName" required></label><label class="field"><span>Email</span><input class="in" id="nEmail" type="email" required></label></div><div class="row3">' +
        '<label class="field"><span>Temporary password</span><input class="in" id="nPass" type="text" autocomplete="off" required minlength="8"></label>' +
        '<label class="field"><span>Vehicle</span><input class="in" id="nVeh"></label><label class="field"><span>₹ per km</span><input class="in num" id="nRate" type="number" min="0" step="0.5" value="6"></label></div>' +
        '<label class="field" style="max-width:220px"><span>Role</span><select class="in" id="nRole"><option value="executive">Executive</option><option value="admin">Admin</option></select></label>' +
        '<div class="err" id="nErr" hidden></div><button class="btn primary" type="submit" style="align-self:flex-start">Create account</button></form></div>';
      el.innerHTML = html;
      var rowBody = function (id) { var row = el.querySelector('[data-u="' + id + '"]'), b = {}; Array.prototype.forEach.call(row.querySelectorAll("[data-f]"), function (i) { b[i.dataset.f] = i.value; }); return b; };
      Array.prototype.forEach.call(el.querySelectorAll("[data-approve]"), function (b) {
        b.addEventListener("click", function () { var body = rowBody(b.dataset.approve); body.approve = true; api("/api/users/" + b.dataset.approve, "PATCH", body).then(viewTeam).catch(function (e) { say("pErr", e.message, "err"); }); });
      });
      Array.prototype.forEach.call(el.querySelectorAll("[data-reject]"), function (b) {
        b.addEventListener("click", function () {
          if (b.dataset.armed) { api("/api/users/" + b.dataset.reject, "DELETE", {}).then(viewTeam).catch(function (e) { say("pErr", e.message, "err"); }); return; }
          b.dataset.armed = "1"; b.textContent = "Tap again to reject";
        });
      });
      Array.prototype.forEach.call(el.querySelectorAll("[data-save]"), function (b) {
        b.addEventListener("click", function () { api("/api/users/" + b.dataset.save, "PATCH", rowBody(b.dataset.save)).then(function () { say("tErr", "Saved.", "ok"); }).catch(function (e) { say("tErr", e.message, "err"); }); });
      });
      Array.prototype.forEach.call(el.querySelectorAll("[data-active]"), function (b) {
        b.addEventListener("click", function () { api("/api/users/" + b.dataset.active, "PATCH", { active: b.dataset.to === "true" }).then(viewTeam).catch(function (e) { say("tErr", e.message, "err"); }); });
      });
      $("newUser").addEventListener("submit", function (ev) {
        ev.preventDefault();
        api("/api/users", "POST", { name: $("nName").value, email: $("nEmail").value, password: $("nPass").value, vehicle: $("nVeh").value, ratePerKm: $("nRate").value, role: $("nRole").value })
          .then(viewTeam).catch(function (e) { say("nErr", e.message, "err"); });
      });
    }).catch(handleAuth);
  }

  /* ---------- rules and outside access (admin) ---------- */
  var RULES = [
    ["Live tracking", [
      ["trackAccuracyM", "Weak GPS limit (m)", "Readings less accurate than this are skipped."],
      ["stationaryM", "Standing-still limit (m)", "Movement smaller than this is treated as GPS drift and not counted."],
      ["maxSpeedKmh", "Highest believable speed (km/h)", "Faster movement between two readings is treated as fake or skipped, and not counted."],
      ["maxGapMin", "Longest silence while moving (min)", "If the phone moves while sending nothing for longer than this, that distance is not counted. Raise it to count phones that sleep in a pocket."],
      ["shiftTimeoutMin", "Close a day after silence (min)", "A signed-in day with no signal for this long is closed automatically at the last signal."]]],
    ["Visit distance check", [
      ["minLegKm", "Minimum distance between places (km)", "Places closer than this are flagged as short hops."],
      ["minStayMin", "Minimum stay at a place (min)", "Shorter visits are flagged."],
      ["roadFactor", "Road factor", "Straight-line distance between places is multiplied by this."],
      ["checkoutRadiusM", "Check-out distance limit (m)", "Check-out must be this close to the check-in point."],
      ["maxAccuracyM", "Weak GPS limit for visits (m)", "Check-in and check-out readings weaker than this are flagged."]]]
  ];
  function viewRules() {
    var el = $("view");
    Promise.all([api("/api/settings"), api("/api/admin/api-key")]).then(function (res) {
      var st = res[0].settings, key = res[1];
      var html = '<div class="card"><header><h2>Rules</h2></header><form id="rulesForm" class="stack" novalidate>' +
        '<label class="field" style="max-width:420px"><span>Registration</span><select class="in" data-k="registrationOpen"><option value="1"' + (st.registrationOpen ? " selected" : "") + '>Open: people can register, you approve</option><option value="0"' + (st.registrationOpen ? "" : " selected") + ">Closed: only you create accounts</option></select></label>" +
        RULES.map(function (g) {
          return "<h3>" + g[0] + "</h3>" + g[1].map(function (x) {
            return '<label class="field" style="max-width:420px"><span>' + x[1] + '</span><input class="in num" data-k="' + x[0] + '" type="number" min="0" step="any" value="' + st[x[0]] + '"><span class="hint" style="text-transform:none;letter-spacing:0">' + x[2] + "</span></label>";
          }).join("");
        }).join("") + '<div id="rMsg" hidden></div><button class="btn primary" type="submit" style="align-self:flex-start">Save rules</button></form>' +
        '<div class="hint">Rules apply to readings received from now on. Days already recorded keep their result, and you can adjust them from the Report tab.</div></div>';
      var base = location.origin;
      html += '<div class="card"><header><h2>Reports for other apps</h2></header>' +
        '<div class="muted">Create a key so Excel, Google Sheets or your own software can read the monthly reports, including check-in and check-out visits, without signing in here.</div>' +
        '<div id="keyBox" class="stack">' + (key.exists ? '<div class="ok">An access key is active. Create a new one to replace it, or turn it off.</div>' : '<div class="hint">No key yet. Outside access is off.</div>') + "</div>" +
        '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" id="mkKey" type="button">' + (key.exists ? "Replace key" : "Create key") + "</button>" + (key.exists ? '<button class="btn danger" id="rmKey" type="button">Turn off</button>' : "") + "</div>" +
        '<div class="stack"><div class="hint">Addresses (replace YOUR_KEY and the month). Use tz=-330 for India time. Add &amp;email=person@company.com for one executive.</div>' +
        ["summary.csv", "shifts.csv", "visits.csv", "report.json"].map(function (f) { return '<code class="url">' + esc(base) + "/api/external/" + f + "?month=2026-10&amp;tz=-330&amp;key=YOUR_KEY</code>"; }).join("") +
        '<div class="hint">Excel: Data, Get Data, From Web. Google Sheets: =IMPORTDATA("address"). Programs can send the key as an "Authorization: Bearer YOUR_KEY" header instead. Google Sheets and other outside apps can reach the address only when this app is on the internet over HTTPS.</div></div></div>';
      el.innerHTML = html;
      $("rulesForm").addEventListener("submit", function (ev) {
        ev.preventDefault();
        var body = {};
        Array.prototype.forEach.call(el.querySelectorAll("[data-k]"), function (i) { body[i.dataset.k] = i.value; });
        api("/api/settings", "PUT", body).then(function () { say("rMsg", "Rules saved.", "ok"); }).catch(function (e) { say("rMsg", e.message, "err"); });
      });
      $("mkKey").addEventListener("click", function () {
        api("/api/admin/api-key", "POST", {}).then(function (j) {
          $("keyBox").innerHTML = '<div class="ok">Copy this key now. It is shown only once.</div><input class="in num" id="keyVal" readonly value="' + esc(j.key) + '"><button class="btn" id="cpKey" type="button" style="align-self:flex-start">Copy key</button><div class="hint" id="cpMsg" aria-live="polite"></div>';
          $("keyVal").select();
          $("cpKey").addEventListener("click", function () {
            $("keyVal").select();
            (navigator.clipboard ? navigator.clipboard.writeText(j.key) : Promise.reject()).then(function () { say("cpMsg", "Copied.", "ok"); }).catch(function () { var ok = false; try { ok = document.execCommand("copy"); } catch (e) {} say("cpMsg", ok ? "Copied." : "Press Ctrl+C to copy the selected key.", ok ? "ok" : "hint"); });
          });
          $("mkKey").textContent = "Replace key";
        }).catch(function (e) { say("rMsg", e.message, "err"); });
      });
      if ($("rmKey")) $("rmKey").addEventListener("click", function () {
        var b = this;
        if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Tap again to turn off"; return; }
        api("/api/admin/api-key", "DELETE", {}).then(viewRules);
      });
    }).catch(handleAuth);
  }

  /* ---------- account ---------- */
  function viewAccount() {
    var el = $("view");
    el.innerHTML = '<div class="card"><header><h2>Start point</h2></header>' +
      '<div class="muted">' + (S.me.baseLat != null ? "Saved: " + esc(S.me.baseName) : "Not saved yet.") + " The first visit of each day is measured from here (home or office).</div>" +
      '<form id="baseForm" class="stack" novalidate><label class="field" style="max-width:360px"><span>Name</span><input class="in" id="bName" value="' + esc(S.me.baseName || "") + '" placeholder="Home or office"></label>' +
      '<div id="bMsg" hidden></div><button class="btn" type="submit" style="align-self:flex-start">Use my location as start point</button></form></div>' +
      '<div class="card"><header><h2>Change password</h2></header><form id="pwForm" class="stack" novalidate><div class="row2">' +
      '<label class="field"><span>Current password</span><input class="in" id="pCur" type="password" autocomplete="current-password"></label>' +
      '<label class="field"><span>New password (8+ characters)</span><input class="in" id="pNew" type="password" autocomplete="new-password"></label></div>' +
      '<div id="pMsg" hidden></div><button class="btn primary" type="submit" style="align-self:flex-start">Change password</button></form></div>';
    $("baseForm").addEventListener("submit", function (ev) {
      ev.preventDefault(); say("bMsg", "Getting your location…");
      position().then(function (p) { return api("/api/me/base", "PUT", { lat: p.lat, lng: p.lng, name: $("bName").value }); })
        .then(function () { return api("/api/me"); }).then(function (m) { S.me = m.user; say("bMsg", "Start point saved.", "ok"); })
        .catch(function (e) { say("bMsg", e.message, "err"); });
    });
    $("pwForm").addEventListener("submit", function (ev) {
      ev.preventDefault();
      api("/api/me/password", "POST", { current: $("pCur").value, next: $("pNew").value })
        .then(function () { $("pwForm").reset(); say("pMsg", "Password changed.", "ok"); }).catch(function (e) { say("pMsg", e.message, "err"); });
    });
  }

  function boot() {
    api("/api/me").then(function (r) {
      S.me = r.user; S.tileUrl = r.tileUrl;
      if (S.me.role === "executive") tStart();
      renderShell();
    }).catch(function () { renderLogin(); });
  }
  boot();
})();
