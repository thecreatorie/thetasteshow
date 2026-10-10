(function () {
  var shows = window.TASTE_SHOWS || [];
  var allEventsUrl = window.TASTE_ALL_EVENTS_URL || "https://www.tickettailor.com/events/fitnesstemplellc";

  function parse(date, time) {
    var d = date.split("-").map(Number);
    var t = (time || "00:00").split(":").map(Number);
    return new Date(d[0], d[1] - 1, d[2], t[0], t[1]);
  }

  function fmtTime(time) {
    var t = time.split(":").map(Number);
    var h = t[0] % 12 || 12;
    return h + ":" + String(t[1]).padStart(2, "0") + (t[0] < 12 ? " AM" : " PM");
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  // A show stays listed until the end of its day.
  var now = new Date();
  var upcoming = shows
    .filter(function (s) { return parse(s.date, "23:59") >= now; })
    .sort(function (a, b) { return parse(a.date, a.show) - parse(b.date, b.show); });

  var list = document.getElementById("show-list");
  var heroNext = document.getElementById("hero-next");
  var heroBuy = document.getElementById("hero-buy");
  var stickyBuy = document.getElementById("sticky-buy");

  if (upcoming.length === 0) {
    var empty = el("div", "show-empty");
    empty.appendChild(el("h3", null, "New dates coming soon"));
    empty.appendChild(el("p", null, "The next TASTE is being plated up. Check Ticket Tailor for the latest dates as soon as they drop."));
    var a = el("a", "btn", "See All Dates");
    a.href = allEventsUrl;
    a.target = "_blank";
    a.rel = "noopener";
    empty.appendChild(a);
    list.appendChild(empty);
    heroNext.textContent = "New dates coming soon";
    heroBuy.textContent = "See Dates";
  } else {
    upcoming.forEach(function (s) {
      var start = parse(s.date, s.show);
      var card = el("article", "show");

      var date = el("div", "show__date");
      date.appendChild(el("span", "show__dow", start.toLocaleDateString("en-US", { weekday: "short" })));
      date.appendChild(el("span", "show__day", String(start.getDate())));
      date.appendChild(el("span", "show__mon", start.toLocaleDateString("en-US", { month: "short", year: "numeric" })));
      card.appendChild(date);

      var info = el("div", "show__info");
      info.appendChild(el("h3", null, "TASTE The Show"));
      info.appendChild(el("p", "show__venue", s.venue + " · " + s.address));
      info.appendChild(el("p", "show__times",
        "Doors " + fmtTime(s.doors) + " · Show " + fmtTime(s.show) + (s.end ? " – " + fmtTime(s.end) : "")));
      card.appendChild(info);

      var buy = el("a", "btn", "Buy Tickets");
      buy.href = s.tickets;
      buy.target = "_blank";
      buy.rel = "noopener";
      card.appendChild(buy);

      list.appendChild(card);
    });

    var next = upcoming[0];
    var nextStart = parse(next.date, next.show);
    heroNext.textContent = "Next show: " +
      nextStart.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }) +
      " · " + next.venue;
    heroBuy.href = next.tickets;
    heroBuy.target = "_blank";
    heroBuy.rel = "noopener";
    stickyBuy.href = next.tickets;
    stickyBuy.target = "_blank";
    stickyBuy.rel = "noopener";
  }

  document.getElementById("year").textContent = String(now.getFullYear());

  // Show the floating mobile ticket button once the hero is scrolled past.
  var hero = document.querySelector(".hero");
  if ("IntersectionObserver" in window && hero) {
    new IntersectionObserver(function (entries) {
      stickyBuy.classList.toggle("is-visible", !entries[0].isIntersecting);
    }).observe(hero);
  }
})();
