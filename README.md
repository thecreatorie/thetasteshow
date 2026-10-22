# TASTE The Show

Website for **TASTE the Show** by Fawnia Mondey, a Las Vegas pole, burlesque and variety show at Gipsy Nightclub.

- **Website:** https://thecreatorie.github.io/thetasteshow/ (hosted on GitHub Pages, deployed on every push to `main`)
- **Tickets:** sold by Gipsy Nightclub. Each show on the site has General Admission, VIP and Table buttons that link to Gipsy's ticket pages.

It's a static site: plain HTML, CSS and a little JavaScript, with no build step and no backend.

## Adding ticket links

The 2027 shows are in the **Tickets** section of `index.html` (search for `class="show"`). Each show has three buttons:

```html
<a class="tier is-soon" data-tier="ga" aria-disabled="true">…<span class="tier__cta">Coming soon</span></a>
```

To turn one on, add the Gipsy link and drop the "coming soon" bits:

```html
<a class="tier" data-tier="ga" href="https://…gipsy link…" target="_blank" rel="noopener">…<span class="tier__cta">Buy</span></a>
```

## Adding or changing shows

Copy a `<article class="show" data-date="YYYY-MM-DD">` block and edit the date, times and links.
Shows hide themselves automatically the day after they happen, and the "Next show" badge in the hero
updates to the next upcoming date.

## Files

| Path | What it is |
| --- | --- |
| `index.html` | The whole site |
| `assets/css/style.css` | Vegas neon design system |
| `assets/js/main.js` | Mobile menu, sticky ticket button, next-show badge, hiding past shows |
| `assets/img/` | Logo, photos, favicon and social share image |
| `.github/workflows/pages.yml` | Deploys to GitHub Pages |

## Custom domain

To serve the site at tastetheshow.com, point the domain's DNS at GitHub Pages:

- `A` records for `@` → `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
- `CNAME` for `www` → `thecreatorie.github.io`

Then set the custom domain under the repo's **Settings → Pages** and tick **Enforce HTTPS**.
