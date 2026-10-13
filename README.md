# TASTE The Show

Website and ticketing system for **TASTE the Show** by Fawnia Mondey, a Las Vegas burlesque and variety show
(pole artistry, burlesque, acrobatics, contortion and dance) at Gipsy Nightclub.

- **Website:** https://thecreatorie.github.io/thetasteshow/ (hosted on GitHub Pages)
- **Tickets:** sold directly on the site. Stripe processes card payments, and Supabase stores shows, orders and tickets.

## Pages

| Page | Who it's for | What it does |
| --- | --- | --- |
| `/` | Everyone | Show info, upcoming dates, ticket picker (GA / VIP / Table) and on-page card checkout |
| `/tickets.html?order=…` | Buyers | Their tickets, with one QR code and one unique code (e.g. `TST-7KQ4-M9XP`) per guest |
| `/door.html` | Door staff | Scan QR codes with a phone camera (or type the code). Shows ✅ valid, ⚠️ already used, ❌ fake |
| `/admin.html` | Producers | Add and edit shows and prices, see sales, guest list with **PDF / CSV export**, comp tickets, staff password |

`door.html` and `admin.html` need the staff password, which you can change under Admin → Settings.

## How ticketing works

1. A buyer picks tickets. The server reserves the seats for 33 minutes, so two people can't buy the last seat.
2. They pay with Stripe's embedded checkout, which stays on our page.
3. Once Stripe confirms payment (through a webhook, or by checking when the ticket page loads), the database
   issues **one ticket per person admitted**, each with a unique, hard-to-guess code. A "Table for 4" creates
   4 tickets, so guests can arrive separately.
4. The buyer lands on their ticket page with QR codes. The link is also in their Stripe receipt, and in an
   email if emailing is switched on.
5. At the door, each code can be checked in once. Scanning it a second time shows "Already used".

## One-time setup: switch on card payments

Until this is done, the site shows "On Sale Soon". Comps and the door scanner work already.

1. Create a Stripe account at https://dashboard.stripe.com/register. Start in **test mode** to try it out
   with the test card `4242 4242 4242 4242`.
2. Stripe → **Developers → API keys**: copy the publishable key (`pk_…`) and the secret key (`sk_…`).
3. Supabase → project **taste-show** → **Edge Functions → Secrets**
   (https://supabase.com/dashboard/project/yrhgqdsawniskkczclfc/functions/secrets). Add:
   - `STRIPE_PUBLISHABLE_KEY` = `pk_…`
   - `STRIPE_SECRET_KEY` = `sk_…`
4. Stripe → **Developers → Webhooks → Add endpoint**
   - URL: `https://yrhgqdsawniskkczclfc.supabase.co/functions/v1/api/stripe-webhook`
   - Events: `checkout.session.completed`, `checkout.session.expired`,
     `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`
   - Copy the signing secret (`whsec_…`) into a Supabase secret named `STRIPE_WEBHOOK_SECRET`.

To go live later, repeat steps 2–4 with your **live** keys instead of the test ones.

### Optional: email tickets to buyers

Create a [Resend](https://resend.com) account, verify your domain, then add the Supabase secrets
`RESEND_API_KEY` and `EMAIL_FROM` (e.g. `TASTE <tickets@yourdomain.com>`).

## Adding a show

Admin → **+ Add Show**. New shows start with General Admission, VIP and Table for 4 at placeholder prices
($35 / $65 / $300). Edit the prices and capacities under **Edit show & prices**. Untick **On sale** to hide a show.

## Code layout

| Path | What it is |
| --- | --- |
| `index.html`, `assets/js/main.js` | Public site and ticket purchase |
| `tickets.html`, `door.html`, `admin.html`, `assets/js/admin.js` | Ticket, door and admin pages |
| `assets/js/config.js` | Supabase URL and **publishable** key (safe to be public) |
| `supabase/migrations/` | Database tables, row-level security and functions (capacity checks, codes, check-in) |
| `supabase/functions/api/index.ts` | Server API: checkout, Stripe webhook, order lookup, staff actions |

The public key can only read shows and seat availability. Orders, tickets and staff actions go through the
server function, which checks the staff password or Stripe's signature.

## Preview locally

```sh
python3 -m http.server 8000
# open http://localhost:8000
```
