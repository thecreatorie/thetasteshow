# TASTE The Show

Website for **TASTE the Show** by Fawnia Mondey — a Las Vegas burlesque & variety show
(pole artistry, burlesque, acrobatics, contortion and dance) at Gipsy Nightclub.

It's a plain static site (HTML/CSS/JS, no build step) hosted on GitHub Pages.
Ticket sales are handled by [Ticket Tailor](https://www.tickettailor.com/events/fitnesstemplellc).

## Adding a new show date

Edit **`assets/js/shows.js`** — that's the only file you need to touch.
Copy an existing entry, change the date/times, and paste in the Ticket Tailor event link:

```js
{
  date: "2026-11-18",          // YYYY-MM-DD
  doors: "19:00",              // 24-hour time
  show: "20:00",
  end: "21:30",
  venue: "Gipsy Nightclub",
  address: "4605 Paradise Rd, Las Vegas, NV 89169",
  tickets: "https://www.tickettailor.com/events/fitnesstemplellc/XXXXXXX",
},
```

Shows hide themselves automatically once their date has passed. If no upcoming
show is listed, the site shows "New dates coming soon" and links to the Ticket
Tailor event page.

You can edit the file right on github.com (click the file → pencil icon → Commit changes).
The site redeploys automatically within a minute or two.

## Turning on GitHub Pages (one time)

1. Merge this into the `main` branch.
2. In the repo go to **Settings → Pages**.
3. Under **Build and deployment → Source**, choose **GitHub Actions**.
4. The site will be live at `https://<your-github-username>.github.io/thetasteshow/`
   (the Actions tab shows the exact URL after each deploy).

### Custom domain (optional)

To use something like `tastetheshow.com`: in **Settings → Pages → Custom domain**, enter the
domain, then at your domain registrar add the DNS records GitHub shows you
([GitHub's guide](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site)).

## Files

| File | What it is |
| --- | --- |
| `index.html` | All page content (about, venue, FAQ text) |
| `assets/js/shows.js` | Show dates & ticket links |
| `assets/css/style.css` | Colors, fonts, layout |
| `assets/img/hero.jpg` | Main hero photo — replace with a new photo using the same name |

## Preview locally

```sh
python3 -m http.server 8000
# open http://localhost:8000
```
