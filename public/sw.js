/* Shows admin alerts as pop-ups, even when the KM Tracker page is closed or in another tab. */
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener("push", function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { title: "KM Tracker", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "KM Tracker", {
    body: d.body || "",
    tag: "km-" + (d.id || Date.now()),
    requireInteraction: true,
    data: { url: d.url || "/#alerts" }
  }));
});
self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || "/#alerts";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.url.indexOf(self.location.origin) === 0 && "focus" in c) {
        return c.focus().then(function (w) { try { w.postMessage({ type: "open-alerts" }); } catch (x) {} return w; });
      }
    }
    return self.clients.openWindow(url);
  }));
});
