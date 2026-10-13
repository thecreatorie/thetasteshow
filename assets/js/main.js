(function () {
  var F = window.TasteFmt, esc = window.TasteEsc, API = window.TasteAPI;

  var list = document.getElementById("show-list");
  var form = document.getElementById("buy");
  var ttWrap = document.getElementById("ticket-types");
  var totalEl = document.getElementById("buy-total");
  var submitBtn = document.getElementById("buy-submit");
  var errEl = document.getElementById("buy-error");
  var heroNext = document.getElementById("hero-next");
  var stickyBuy = document.getElementById("sticky-buy");

  var shows = [], remaining = {}, salesOpen = false, current = null, qty = {};

  document.getElementById("year").textContent = String(new Date().getFullYear());

  Promise.all([
    API.rest("/shows?select=*,ticket_types(*)&on_sale=eq.true&order=starts_at.asc"),
    API.rpc("get_availability"),
    API.get("/status").catch(function () { return { sales_open: false }; }),
  ]).then(function (r) {
    var now = Date.now();
    shows = r[0].filter(function (s) { return new Date(s.starts_at).getTime() + 3 * 3600e3 > now; });
    r[1].forEach(function (a) { remaining[a.ticket_type_id] = a.remaining; });
    salesOpen = !!r[2].sales_open;
    renderShows();
  }).catch(function () {
    list.innerHTML = '<div class="show-empty"><h3>Couldn\'t load shows</h3><p>Please refresh the page in a moment.</p></div>';
  });

  function renderShows() {
    list.innerHTML = "";
    if (!shows.length) {
      list.innerHTML = '<div class="show-empty"><h3>New dates coming soon</h3><p>The next TASTE is being plated up. Check back soon — new dates will be announced here first.</p></div>';
      heroNext.textContent = "New dates coming soon";
      return;
    }
    shows.forEach(function (s) {
      var p = F.parts(s.starts_at);
      var types = (s.ticket_types || []).filter(function (t) { return t.active; });
      var left = types.reduce(function (n, t) { return n + (remaining[t.id] || 0); }, 0);
      var from = types.length ? Math.min.apply(null, types.map(function (t) { return t.price_cents; })) : 0;
      var card = document.createElement("article");
      card.className = "show";
      card.innerHTML =
        '<div class="show__date"><span class="show__dow">' + esc(p.dow) + '</span><span class="show__day">' + esc(p.day) +
        '</span><span class="show__mon">' + esc(p.mon) + "</span></div>" +
        '<div class="show__info"><h3>' + esc(s.title) + "</h3>" +
        '<p class="show__venue">' + esc(s.venue) + " · " + esc(s.address) + "</p>" +
        '<p class="show__times">' + (s.doors_at ? "Doors " + F.time(s.doors_at) + " · " : "") + "Show " + F.time(s.starts_at) +
        (s.ends_at ? " – " + F.time(s.ends_at) : "") + (types.length ? " · from " + F.money(from) : "") + "</p></div>";
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn";
      if (!salesOpen) { btn.textContent = "On Sale Soon"; btn.disabled = true; }
      else if (left <= 0) { btn.textContent = "Sold Out"; btn.disabled = true; }
      else { btn.textContent = "Get Tickets"; btn.addEventListener("click", function () { select(s, card); }); }
      card.appendChild(btn);
      list.appendChild(card);
    });

    var next = shows[0];
    heroNext.textContent = "Next show: " + F.date(next.starts_at) + " · " + next.venue;
    if (shows.length === 1 && salesOpen) select(shows[0], list.firstChild, true);
  }

  function select(show, card, quiet) {
    current = show;
    qty = {};
    Array.prototype.forEach.call(list.children, function (c) { c.classList.toggle("is-selected", c === card); });
    document.getElementById("buy-title").textContent = "Tickets for " + F.date(show.starts_at);
    ttWrap.innerHTML = "";
    (show.ticket_types || []).filter(function (t) { return t.active; })
      .sort(function (a, b) { return a.sort - b.sort; })
      .forEach(function (t) {
        var left = remaining[t.id] || 0;
        var max = Math.min(left, t.max_per_order);
        qty[t.id] = 0;
        var row = document.createElement("div");
        row.className = "tt" + (left <= 0 ? " is-soldout" : "");
        row.innerHTML =
          '<div class="tt__info"><h4>' + esc(t.name) + ' <span class="tt__price">' + F.money(t.price_cents) + "</span></h4>" +
          (t.description ? "<p>" + esc(t.description) + "</p>" : "") +
          (left <= 0 ? '<p class="tt__left">Sold out</p>' : left <= 10 ? '<p class="tt__left">Only ' + left + " left</p>" : "") +
          "</div>" +
          '<div class="stepper" aria-label="Quantity for ' + esc(t.name) + '">' +
          '<button type="button" data-d="-1" aria-label="Remove one">−</button>' +
          '<output aria-live="polite">0</output>' +
          '<button type="button" data-d="1" aria-label="Add one">+</button></div>';
        var out = row.querySelector("output");
        row.querySelectorAll("button").forEach(function (b) {
          b.disabled = left <= 0 || b.dataset.d === "-1";
          b.addEventListener("click", function () {
            qty[t.id] = Math.max(0, Math.min(max, qty[t.id] + Number(b.dataset.d)));
            out.textContent = qty[t.id];
            row.querySelector('[data-d="-1"]').disabled = qty[t.id] === 0;
            row.querySelector('[data-d="1"]').disabled = qty[t.id] >= max;
            updateTotal();
          });
        });
        ttWrap.appendChild(row);
      });
    form.hidden = false;
    updateTotal();
    if (!quiet) form.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function updateTotal() {
    var total = 0, count = 0;
    (current.ticket_types || []).forEach(function (t) {
      total += (qty[t.id] || 0) * t.price_cents;
      count += qty[t.id] || 0;
    });
    totalEl.textContent = F.money(total);
    submitBtn.disabled = count === 0;
  }

  function showError(msg) {
    errEl.textContent = msg;
    errEl.hidden = !msg;
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    showError("");
    var data = new FormData(form);
    var name = String(data.get("name") || "").trim();
    var email = String(data.get("email") || "").trim();
    if (!name) return showError("Please enter your name.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showError("Please enter a valid email so we can send your tickets.");
    var items = Object.keys(qty).filter(function (id) { return qty[id] > 0; })
      .map(function (id) { return { ticket_type_id: id, quantity: qty[id] }; });

    submitBtn.disabled = true;
    submitBtn.textContent = "One moment…";
    API.post("/checkout", { show_id: current.id, items: items, name: name, email: email, phone: data.get("phone") })
      .then(openPayment)
      .catch(function (err) {
        showError(err.message === "not_configured" ? "Online sales aren't open yet — please check back soon." : err.message);
      })
      .then(function () {
        submitBtn.textContent = "Continue to Payment";
        updateTotal();
      });
  });

  // ── Stripe embedded checkout ──
  var modal = document.getElementById("pay-modal");
  var checkout = null;

  function loadStripe() {
    if (window.Stripe) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = "https://js.stripe.com/v3/";
      s.onload = resolve;
      s.onerror = function () { reject(new Error("Couldn't load the payment form. Please check your connection.")); };
      document.head.appendChild(s);
    });
  }

  function openPayment(res) {
    return loadStripe().then(function () {
      var stripe = window.Stripe(res.publishable_key);
      return stripe.initEmbeddedCheckout({ fetchClientSecret: function () { return Promise.resolve(res.client_secret); } });
    }).then(function (c) {
      checkout = c;
      modal.hidden = false;
      document.body.classList.add("no-scroll");
      c.mount("#stripe-checkout");
    });
  }

  function closePayment() {
    if (checkout) { checkout.destroy(); checkout = null; }
    modal.hidden = true;
    document.body.classList.remove("no-scroll");
  }

  document.getElementById("pay-close").addEventListener("click", closePayment);
  modal.addEventListener("click", function (e) { if (e.target === modal) closePayment(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !modal.hidden) closePayment(); });

  // Header: solid background once scrolled, and the mobile menu toggle.
  var nav = document.querySelector(".nav");
  var toggle = nav.querySelector(".nav__toggle");
  function onScroll() { nav.classList.toggle("is-scrolled", window.scrollY > 40); }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  function setMenu(open) {
    nav.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  }
  toggle.addEventListener("click", function () { setMenu(!nav.classList.contains("is-open")); });
  nav.querySelectorAll("a").forEach(function (a) { a.addEventListener("click", function () { setMenu(false); }); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") setMenu(false); });

  // Floating mobile ticket button once the hero is scrolled past.
  var hero = document.querySelector(".hero");
  if ("IntersectionObserver" in window && hero) {
    new IntersectionObserver(function (entries) {
      stickyBuy.classList.toggle("is-visible", !entries[0].isIntersecting);
    }).observe(hero);
  }
})();
