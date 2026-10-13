// Shared helpers for talking to the ticketing backend.
(function () {
  var cfg = window.TASTE_CONFIG;
  var FN = cfg.supabaseUrl + "/functions/v1/api";
  var REST = cfg.supabaseUrl + "/rest/v1";
  var TZ = cfg.timeZone;

  function handle(res) {
    return res.json().catch(function () { return {}; }).then(function (data) {
      if (!res.ok) {
        var err = new Error(data.error || "Something went wrong. Please try again.");
        err.status = res.status;
        throw err;
      }
      return data;
    });
  }

  var headers = { apikey: cfg.supabaseKey };

  window.TasteAPI = {
    rest: function (path) {
      return fetch(REST + path, { headers: headers }).then(handle);
    },
    rpc: function (name, args) {
      return fetch(REST + "/rpc/" + name, {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, headers),
        body: JSON.stringify(args || {}),
      }).then(handle);
    },
    get: function (route) {
      return fetch(FN + route, { headers: headers }).then(handle);
    },
    post: function (route, body) {
      return fetch(FN + route, {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, headers),
        body: JSON.stringify(body),
      }).then(handle);
    },
  };

  // ── Formatting (always in Las Vegas time) ──
  function fmt(iso, opts) {
    return new Date(iso).toLocaleString("en-US", Object.assign({ timeZone: TZ }, opts));
  }

  window.TasteFmt = {
    date: function (iso) { return fmt(iso, { weekday: "long", month: "long", day: "numeric", year: "numeric" }); },
    shortDate: function (iso) { return fmt(iso, { weekday: "short", month: "short", day: "numeric" }); },
    time: function (iso) { return fmt(iso, { hour: "numeric", minute: "2-digit" }); },
    dateTime: function (iso) { return fmt(iso, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); },
    parts: function (iso) {
      return {
        dow: fmt(iso, { weekday: "short" }),
        day: fmt(iso, { day: "numeric" }),
        mon: fmt(iso, { month: "short", year: "numeric" }),
      };
    },
    money: function (cents) {
      return "$" + (cents / 100).toFixed(cents % 100 === 0 ? 0 : 2);
    },
    // "2026-11-18T20:00" (Las Vegas wall clock) -> ISO string in UTC.
    localToISO: function (local) {
      if (!local) return null;
      var m = local.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
      if (!m) return null;
      var guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
      for (var i = 0; i < 2; i++) {
        var p = wallParts(new Date(guess));
        var asUTC = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
        guess += Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - asUTC;
      }
      return new Date(guess).toISOString();
    },
    // ISO -> "2026-11-18T20:00" in Las Vegas time, for <input type="datetime-local">.
    isoToLocal: function (iso) {
      if (!iso) return "";
      var p = wallParts(new Date(iso));
      function z(n) { return String(n).padStart(2, "0"); }
      return p.y + "-" + z(p.mo) + "-" + z(p.d) + "T" + z(p.h) + ":" + z(p.mi);
    },
  };

  function wallParts(date) {
    var out = {};
    new Intl.DateTimeFormat("en-US", {
      timeZone: TZ, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
    }).formatToParts(date).forEach(function (p) { out[p.type] = +p.value; });
    return { y: out.year, mo: out.month, d: out.day, h: out.hour, mi: out.minute };
  }

  window.TasteEsc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
})();
