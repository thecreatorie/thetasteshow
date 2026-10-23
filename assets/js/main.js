(function () {
  var heroNext = document.getElementById("hero-next");
  var stickyBuy = document.getElementById("sticky-buy");

  document.getElementById("year").textContent = String(new Date().getFullYear());

  // Hide shows once their night is over (Las Vegas time) and point the hero at the next one.
  var today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  var shows = Array.prototype.filter.call(document.querySelectorAll(".show[data-date]"), function (el) {
    var past = el.dataset.date < today;
    el.hidden = past;
    return !past;
  });
  if (shows.length) {
    var d = new Date(shows[0].dataset.date + "T12:00:00");
    // index.html ships with the first show pre-rendered (no layout shift); only update if it changed.
    var next = "Next show: " + d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }) + " · Gipsy Nightclub";
    if (heroNext.textContent !== next) heroNext.textContent = next;
  } else {
    heroNext.textContent = "New dates coming soon";
    var list = document.querySelector(".show-list");
    if (list) list.insertAdjacentHTML("beforeend", '<div class="show-empty"><h3>New dates coming soon</h3><p>The next TASTE is being plated up. Follow @tastetheshow — new dates are announced there first.</p></div>');
  }

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
