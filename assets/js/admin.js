(function () {
  var F = TasteFmt, esc = TasteEsc;
  var PROJECT = "yrhgqdsawniskkczclfc";
  var WEBHOOK_URL = TASTE_CONFIG.supabaseUrl + "/functions/v1/api/stripe-webhook";
  var pw = "", wantShow = "", status = {}, shows = [], guests = [], editing = null;
  try { pw = sessionStorage.getItem("taste_staff") || ""; } catch (e) {}

  function $(id) { return document.getElementById(id); }
  function staff(body) { return TasteAPI.post("/staff", Object.assign({ password: pw }, body)); }
  function toast(msg) {
    var t = $("toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { t.hidden = true; }, 2600);
  }
  function fail(el, e) { el.textContent = e.message || String(e); el.hidden = false; }

  // ── Login ──
  if (pw) staff({ action: "login" }).then(enter).catch(function () { pw = ""; });
  $("login").addEventListener("submit", function (e) {
    e.preventDefault();
    pw = new FormData(this).get("password");
    $("login-error").hidden = true;
    staff({ action: "login" }).then(function (r) {
      try { sessionStorage.setItem("taste_staff", pw); } catch (e) {}
      enter(r);
    }).catch(function (e) { fail($("login-error"), e); });
  });

  function enter(r) {
    status = r;
    $("login").hidden = true;
    $("tabs").hidden = false;
    renderSetup();
    loadShows().then(function () { go("shows"); });
  }

  // ── Navigation ──
  function go(view) {
    document.querySelectorAll(".view").forEach(function (v) { v.hidden = v.id !== "view-" + view; });
    document.querySelectorAll("#tabs button").forEach(function (b) { b.classList.toggle("is-active", b.dataset.view === view); });
    if (view === "guests") loadGuests();
    if (view === "comp") fillCompShows();
    window.scrollTo(0, 0);
  }
  document.querySelectorAll("[data-view]").forEach(function (b) { b.addEventListener("click", function () { go(b.dataset.view); }); });
  document.querySelectorAll("[data-go]").forEach(function (b) { b.addEventListener("click", function () { loadShows().then(function () { go(b.dataset.go); }); }); });

  // ── Setup notice (Stripe not connected yet) ──
  function renderSetup() {
    var html = '<h2>Online sales status</h2>' +
      '<p>Card payments (Stripe): ' + (status.stripe_configured ? '<span class="pill pill--ok">Connected</span>' : '<span class="pill pill--bad">Not connected</span>') + "</p>" +
      '<p>Ticket emails: ' + (status.email_configured ? '<span class="pill pill--ok">On</span>' : '<span class="pill pill--warn">Off — buyers still get their tickets on screen and in their Stripe receipt</span>') + "</p>";
    if (!status.stripe_configured) {
      html += '<ol>' +
        '<li>Create a free account at <a href="https://dashboard.stripe.com/register" target="_blank" rel="noopener">stripe.com</a>. You can start in <b>test mode</b>.</li>' +
        '<li>In Stripe go to <b>Developers → API keys</b>. Copy the <b>Publishable key</b> (pk_…) and the <b>Secret key</b> (sk_…).</li>' +
        '<li>Open <a href="https://supabase.com/dashboard/project/' + PROJECT + '/functions/secrets" target="_blank" rel="noopener">Supabase → Edge Functions → Secrets</a> and add <code>STRIPE_PUBLISHABLE_KEY</code> and <code>STRIPE_SECRET_KEY</code>.</li>' +
        '<li>In Stripe go to <b>Developers → Webhooks → Add endpoint</b>. URL: <code>' + WEBHOOK_URL + '</code>. Events: <code>checkout.session.completed</code>, <code>checkout.session.expired</code>, <code>checkout.session.async_payment_succeeded</code>, <code>checkout.session.async_payment_failed</code>. Copy the signing secret (whsec_…) into a Supabase secret named <code>STRIPE_WEBHOOK_SECRET</code>.</li>' +
        "</ol><p class=\"fine\">Until then, the website shows \"On Sale Soon\" instead of a Buy button. Comp tickets and the door scanner already work.</p>";
    }
    $("status-card").innerHTML = html;
    var setup = $("setup");
    setup.className = "card notice";
    setup.innerHTML = status.stripe_configured ? "" :
      '<strong>Online sales are not switched on yet.</strong> Connect Stripe to start selling — see <a href="#" id="to-settings">Settings</a> for the 4 steps.';
    setup.hidden = !!status.stripe_configured;
    var link = $("to-settings");
    if (link) link.addEventListener("click", function (e) { e.preventDefault(); go("settings"); });
  }

  // ── Shows ──
  function loadShows() {
    return staff({ action: "shows" }).then(function (r) { shows = r.shows; renderShows(); });
  }

  function renderShows() {
    var wrap = $("shows");
    if (!shows.length) {
      wrap.innerHTML = '<div class="card center"><h2>No shows yet</h2><p class="muted">Add your first show to start selling tickets.</p></div>';
      return;
    }
    wrap.innerHTML = "";
    shows.forEach(function (s) {
      var sold = 0, cap = 0, revenue = 0, people = 0;
      s.ticket_types.forEach(function (t) { sold += t.sold; cap += t.capacity; revenue += t.revenue_cents; people += t.sold * t.admits; });
      var past = new Date(s.starts_at).getTime() < Date.now() - 6 * 3600e3;
      var card = document.createElement("div");
      card.className = "card show-admin";
      card.innerHTML =
        '<div class="show-admin__head"><h2>' + esc(F.date(s.starts_at)) + "</h2>" +
        (past ? '<span class="pill">Past</span>' : s.on_sale ? '<span class="pill pill--ok">On sale</span>' : '<span class="pill pill--warn">Hidden</span>') +
        '<span class="spacer"></span>' +
        '<button class="btn btn--small btn--ghost" data-act="edit">Edit show &amp; prices</button>' +
        '<button class="btn btn--small" data-act="guests">Guest list</button></div>' +
        '<p class="muted" style="margin:0">' + esc(s.title) + " · " + esc(s.venue) + " · Show " + F.time(s.starts_at) + "</p>" +
        '<div class="stats">' +
        stat("Revenue", F.money(revenue), "paid orders") +
        stat("Guests", people, s.checked_in + " checked in") +
        s.ticket_types.map(function (t) {
          return stat(t.name, t.sold + " / " + t.capacity, F.money(t.price_cents) + (t.active ? "" : " · off sale"), t.capacity ? t.sold / t.capacity : 0);
        }).join("") +
        "</div>";
      card.querySelector('[data-act="edit"]').addEventListener("click", function () { editShow(s); });
      card.querySelector('[data-act="guests"]').addEventListener("click", function () { wantShow = s.id; go("guests"); });
      wrap.appendChild(card);
    });
  }

  function stat(label, value, sub, pct) {
    return '<div class="stat"><div class="stat__label">' + esc(label) + '</div><div class="stat__value">' + esc(value) +
      '</div><div class="stat__sub">' + esc(sub) + "</div>" +
      (pct != null ? '<div class="bar"><span style="width:' + Math.min(100, Math.round(pct * 100)) + '%"></span></div>' : "") + "</div>";
  }

  // ── Show editor ──
  $("new-show").addEventListener("click", function () { editShow(null); });

  function editShow(s) {
    editing = s;
    var f = $("show-form");
    f.reset();
    $("edit-title").textContent = s ? "Edit show" : "Add show";
    $("new-show-note").hidden = !!s;
    $("show-error").hidden = true;
    if (s) {
      var start = F.isoToLocal(s.starts_at);
      f.date.value = start.slice(0, 10);
      f.start.value = start.slice(11);
      f.doors.value = s.doors_at ? F.isoToLocal(s.doors_at).slice(11) : "";
      f.end.value = s.ends_at ? F.isoToLocal(s.ends_at).slice(11) : "";
      f.venue.value = s.venue; f.address.value = s.address; f.title.value = s.title;
      f.on_sale.checked = s.on_sale;
    }
    renderTicketTypes();
    go("edit");
  }

  $("show-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var f = this, d = f.date.value;
    function at(t) { return t ? F.localToISO(d + "T" + t) : null; }
    var show = {
      id: editing && editing.id, title: f.title.value, venue: f.venue.value, address: f.address.value,
      starts_at: at(f.start.value), doors_at: at(f.doors.value), ends_at: at(f.end.value), on_sale: f.on_sale.checked,
    };
    staff({ action: "save-show", show: show }).then(function (r) {
      toast("Show saved");
      return loadShows().then(function () {
        editing = shows.filter(function (s) { return s.id === r.id; })[0];
        $("edit-title").textContent = "Edit show";
        $("new-show-note").hidden = true;
        renderTicketTypes();
      });
    }).catch(function (e) { fail($("show-error"), e); });
  });

  function renderTicketTypes() {
    $("tt-card").hidden = !editing;
    if (!editing) return;
    var body = $("tt-rows");
    body.innerHTML = "";
    editing.ticket_types.forEach(function (t) { body.appendChild(ttRow(t)); });
  }

  $("add-tt").addEventListener("click", function () {
    $("tt-rows").appendChild(ttRow({ name: "", description: "", price_cents: 0, capacity: 0, admits: 1, max_per_order: 10, active: true, sold: 0, sort: editing.ticket_types.length + 1 }));
  });

  function ttRow(t) {
    var tr = document.createElement("tr");
    tr.innerHTML =
      '<td><input name="name" value="' + esc(t.name) + '" placeholder="e.g. VIP"></td>' +
      '<td><input name="description" value="' + esc(t.description) + '"></td>' +
      '<td><input name="price" type="number" min="0" step="0.01" value="' + (t.price_cents / 100) + '"></td>' +
      '<td><input name="capacity" type="number" min="0" value="' + t.capacity + '"></td>' +
      '<td><input name="admits" type="number" min="1" max="20" value="' + t.admits + '"></td>' +
      '<td><input name="max_per_order" type="number" min="1" value="' + t.max_per_order + '"></td>' +
      "<td>" + t.sold + "</td>" +
      '<td><input name="active" type="checkbox"' + (t.active ? " checked" : "") + "></td>" +
      '<td><button class="btn btn--small" type="button">Save</button></td>';
    tr.querySelector("button").addEventListener("click", function () {
      function v(n) { return tr.querySelector('[name="' + n + '"]'); }
      staff({ action: "save-ticket-type", ticket_type: {
        id: t.id, show_id: editing.id, name: v("name").value, description: v("description").value,
        price_cents: Math.round(parseFloat(v("price").value || "0") * 100), capacity: v("capacity").value,
        admits: v("admits").value, max_per_order: v("max_per_order").value, active: v("active").checked, sort: t.sort,
      } }).then(function (r) {
        t.id = r.id;
        toast("Saved " + v("name").value);
        loadShows().then(function () { editing = shows.filter(function (s) { return s.id === editing.id; })[0]; });
      }).catch(function (e) { toast(e.message); });
    });
    return tr;
  }

  // ── Guest list ──
  function fillShowSelect(sel, keep) {
    var prev = wantShow || (keep ? sel.value : "");
    wantShow = "";
    sel.innerHTML = shows.map(function (s) { return '<option value="' + s.id + '">' + esc(F.shortDate(s.starts_at) + " · " + s.title) + "</option>"; }).join("");
    if (prev) sel.value = prev;
    if (!sel.value && shows.length) {
      var upcoming = shows.filter(function (s) { return new Date(s.starts_at).getTime() > Date.now() - 6 * 3600e3; });
      sel.value = (upcoming[upcoming.length - 1] || shows[0]).id;
    }
  }

  $("guest-show").addEventListener("change", loadGuests);
  $("guest-search").addEventListener("input", renderGuests);

  function loadGuests() {
    var sel = $("guest-show");
    fillShowSelect(sel, true);
    if (!sel.value) { $("guest-rows").innerHTML = '<tr><td colspan="6" class="muted">No shows yet.</td></tr>'; return; }
    $("guest-rows").innerHTML = '<tr><td colspan="6" class="muted">Loading…</td></tr>';
    staff({ action: "attendees", show_id: sel.value }).then(function (r) {
      guests = r.tickets.sort(function (a, b) {
        return a.holder_name.localeCompare(b.holder_name) || a.ticket_type.sort - b.ticket_type.sort ||
          a.label.localeCompare(b.label, undefined, { numeric: true });
      });
      renderGuests();
    }).catch(function (e) { toast(e.message); });
  }

  function filteredGuests() {
    var q = $("guest-search").value.trim().toLowerCase();
    if (!q) return guests;
    return guests.filter(function (g) {
      return (g.holder_name + " " + g.order.buyer_email + " " + g.code + " " + g.order.buyer_phone).toLowerCase().indexOf(q) >= 0;
    });
  }

  function renderGuests() {
    var list = filteredGuests();
    var valid = guests.filter(function (g) { return !g.voided; });
    var inCount = valid.filter(function (g) { return g.checked_in_at; }).length;
    $("guest-summary").textContent = valid.length + " tickets · " + inCount + " checked in";
    var body = $("guest-rows");
    if (!list.length) { body.innerHTML = '<tr><td colspan="6" class="muted">No tickets yet.</td></tr>'; return; }
    body.innerHTML = "";
    list.forEach(function (g) {
      var tr = document.createElement("tr");
      if (g.voided) tr.className = "is-void";
      tr.innerHTML =
        "<td><strong>" + esc(g.holder_name) + "</strong>" + (g.order.status === "comp" ? ' <span class="pill">Comp</span>' : "") +
        (g.order.note ? '<br><span class="fine">' + esc(g.order.note) + "</span>" : "") + "</td>" +
        "<td>" + esc(g.label) + "</td><td><code>" + esc(g.code) + "</code></td>" +
        "<td>" + esc(contact(g.order.buyer_email)) + (g.order.buyer_phone ? "<br>" + esc(g.order.buyer_phone) : "") + "</td>" +
        "<td>" + (g.voided ? '<span class="pill pill--bad">Void</span>' : g.checked_in_at ? '<span class="pill pill--ok">In ' + F.time(g.checked_in_at) + "</span>" : '<span class="pill">Not yet</span>') + "</td>" +
        '<td class="nowrap">' +
        (g.voided ? "" : '<button class="link-btn" data-act="in">' + (g.checked_in_at ? "Undo" : "Check in") + "</button>") +
        '<button class="link-btn" data-act="void">' + (g.voided ? "Restore" : "Void") + "</button>" +
        (g.voided || contact(g.order.buyer_email) === "—" ? "" : '<button class="link-btn" data-act="email" title="Re-send the whole order\'s tickets to ' + esc(g.order.buyer_email) + '">Email</button>') + "</td>";
      var inBtn = tr.querySelector('[data-act="in"]');
      if (inBtn) inBtn.addEventListener("click", function () {
        staff({ action: "checkin", code: g.code, undo: !!g.checked_in_at }).then(function (r) {
          toast(r.result === "ok" ? "Checked in " + g.holder_name : r.result === "undone" ? "Check-in undone" : r.result);
          loadGuests();
        });
      });
      tr.querySelector('[data-act="void"]').addEventListener("click", function () {
        if (!g.voided && !confirm("Void ticket " + g.code + " for " + g.holder_name + "? It will no longer get in at the door.")) return;
        staff({ action: "void", ticket_id: g.id, voided: !g.voided }).then(function () { toast(g.voided ? "Ticket restored" : "Ticket voided"); loadGuests(); });
      });
      var emailBtn = tr.querySelector('[data-act="email"]');
      if (emailBtn) emailBtn.addEventListener("click", function () {
        if (!confirm("Re-send the tickets email for this order to " + g.order.buyer_email + "?")) return;
        staff({ action: "resend-email", order_id: g.order.id }).then(function (r) {
          toast(r.sent ? "Tickets emailed to " + g.order.buyer_email : "Email failed: " + (r.error || "unknown error"));
        }).catch(function (e) { toast(e.message); });
      });
      body.appendChild(tr);
    });
  }

  function contact(email) { return /\.local$/.test(email) ? "—" : email; }

  function currentShow() {
    var id = $("guest-show").value;
    return shows.filter(function (s) { return s.id === id; })[0];
  }

  $("export-csv").addEventListener("click", function () {
    var rows = [["Name", "Ticket", "Code", "Email", "Phone", "Type", "Checked in", "Voided", "Note"]];
    guests.forEach(function (g) {
      rows.push([g.holder_name, g.label, g.code, contact(g.order.buyer_email), g.order.buyer_phone, g.order.status,
        g.checked_in_at ? F.dateTime(g.checked_in_at) : "", g.voided ? "yes" : "", g.order.note]);
    });
    var csv = rows.map(function (r) {
      return r.map(function (c) { c = String(c == null ? "" : c); return /[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c; }).join(",");
    }).join("\n");
    download(new Blob([csv], { type: "text/csv" }), fileName("csv"));
  });

  $("export-pdf").addEventListener("click", function () {
    var s = currentShow();
    if (!s) return;
    var doc = new window.jspdf.jsPDF({ orientation: "portrait", unit: "pt", format: "letter" });
    var valid = guests.filter(function (g) { return !g.voided; });
    doc.setFont("helvetica", "bold");
    doc.setFontSize(20);
    doc.text("TASTE — Guest List", 40, 50);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.text(F.date(s.starts_at) + "  ·  Show " + F.time(s.starts_at) + "  ·  " + s.venue, 40, 70);
    doc.text(valid.length + " tickets  ·  " + valid.filter(function (g) { return g.checked_in_at; }).length + " checked in  ·  printed " + F.dateTime(new Date().toISOString()), 40, 86);
    doc.autoTable({
      startY: 104,
      head: [["", "Name", "Ticket", "Code", "Contact"]],
      body: valid.map(function (g) {
        return [g.checked_in_at ? "X" : "", g.holder_name + (g.order.status === "comp" ? " (comp)" : ""), g.label, g.code,
          contact(g.order.buyer_email) + (g.order.buyer_phone ? "\n" + g.order.buyer_phone : "")];
      }),
      styles: { fontSize: 9, cellPadding: 5 },
      headStyles: { fillColor: [224, 24, 45] },
      columnStyles: { 0: { cellWidth: 22, halign: "center", fontStyle: "bold" }, 3: { font: "courier" } },
      didDrawCell: function (data) {
        if (data.section === "body" && data.column.index === 0) {
          doc.rect(data.cell.x + 6, data.cell.y + 5, 10, 10);
        }
      },
    });
    doc.save(fileName("pdf"));
  });

  function fileName(ext) {
    var s = currentShow();
    return "taste-guest-list-" + (s ? F.isoToLocal(s.starts_at).slice(0, 10) : "show") + "." + ext;
  }

  function download(blob, name) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  // ── Comps ──
  function fillCompShows() {
    fillShowSelect($("comp-show"), true);
    fillCompTypes();
  }
  $("comp-show").addEventListener("change", fillCompTypes);
  function fillCompTypes() {
    var s = shows.filter(function (x) { return x.id === $("comp-show").value; })[0];
    $("comp-tt").innerHTML = s ? s.ticket_types.map(function (t) {
      return '<option value="' + t.id + '">' + esc(t.name) + " (" + Math.max(0, t.capacity - t.sold) + " left)</option>";
    }).join("") : "";
  }

  $("comp-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var f = this;
    $("comp-error").hidden = true;
    staff({
      action: "comp", show_id: f.show_id.value, name: f.name.value, email: f.email.value, note: f.note.value,
      items: [{ ticket_type_id: f.ticket_type_id.value, quantity: Number(f.quantity.value) }],
    }).then(function (r) {
      $("comp-result").innerHTML = '<div class="card" style="margin:0"><strong>Done!</strong> Send this link to ' + esc(f.name.value) +
        ':<br><a href="' + r.link + '" target="_blank" rel="noopener">' + esc(r.link) + "</a>" +
        (r.email && r.email.sent ? '<p class="fine" style="margin:8px 0 0">✅ Tickets emailed to ' + esc(f.email.value) + ".</p>" :
          r.email && r.email.error ? '<p class="form-error" style="margin:8px 0 0">⚠️ Email not sent: ' + esc(r.email.error) + "</p>" : "") +
        "</div>";
      f.name.value = ""; f.email.value = ""; f.note.value = ""; f.quantity.value = 1;
      return loadShows().then(fillCompTypes);
    }).catch(function (e) { fail($("comp-error"), e); });
  });

  // ── Settings ──
  $("pw-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var f = this, next = f.new_password.value;
    $("pw-error").hidden = true;
    staff({ action: "set-password", new_password: next }).then(function () {
      pw = next;
      try { sessionStorage.setItem("taste_staff", pw); } catch (e) {}
      f.reset();
      toast("Password updated");
    }).catch(function (e) { fail($("pw-error"), e); });
  });
})();
