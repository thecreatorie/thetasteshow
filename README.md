# TASTE The Show

Website for **TASTE the Show** by Fawnia Mondey, a Las Vegas pole, burlesque and variety show at Gipsy Nightclub.

- **Website:** https://tastetheshow.com (hosted on GitHub Pages, deployed on every push to `main`)
- **Tickets:** sold by Gipsy Nightclub. Each show on the site has General Admission, VIP and Table buttons that link to Gipsy's ticket pages.

It's a static site: plain HTML, CSS and a little JavaScript, with no build step and no backend.

## Adding ticket links

The 2027 shows are in the **Tickets** section of `index.html` (search for `class="show"`). Each show has three buttons.
While tickets aren't on sale, a button is a plain `<span>` (not a link, so search engines don't see dead links):

```html
<span class="tier is-soon" data-tier="ga" aria-disabled="true">…<span class="tier__cta">Coming soon</span></span>
```

To turn one on, change the outer `<span>` into an `<a>` with the Gipsy link (remember the closing `</span>` becomes `</a>`), and drop the "coming soon" bits:

```html
<a class="tier" data-tier="ga" href="https://…gipsy link…" target="_blank" rel="noopener">…<span class="tier__cta">Buy</span></a>
```

## Adding or changing shows

Copy a `<article class="show" data-date="YYYY-MM-DD">` block and edit the date, times and links.
Shows hide themselves automatically the day after they happen, and the "Next show" badge in the hero
updates to the next upcoming date. (The badge text is also written into `index.html` so it shows instantly — update it there
when the first listed show changes.)

## Files

| Path | What it is |
| --- | --- |
| `index.html` | The whole site |
| `assets/css/style.css` | Vegas neon design system |
| `assets/js/main.js` | Mobile menu, sticky ticket button, next-show badge, hiding past shows |
| `assets/img/` | Logo, photos, favicon and social share image. Photos also have resized `-480`/`-800`/… `.webp` copies used via `<picture>`/`srcset`; regenerate them if you replace a photo |
| `assets/fonts/` | Self-hosted web fonts (Barlow Condensed, Space Grotesk, Yellowtail) |
| `robots.txt`, `sitemap.xml` | Crawler rules (search engines and AI assistants allowed) and sitemap |
| `llms.txt`, `llms-full.txt` | Plain-text summary of the show for AI assistants ([llmstxt.org](https://llmstxt.org)); update with new dates |
| `.github/workflows/pages.yml` | Deploys to GitHub Pages |

## Custom domain

To serve the site at tastetheshow.com, point the domain's DNS at GitHub Pages:

- `A` records for `@` → `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
- `CNAME` for `www` → `thecreatorie.github.io`

Then set the custom domain under the repo's **Settings → Pages** and tick **Enforce HTTPS**.
