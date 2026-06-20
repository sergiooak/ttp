# TTP — Text-To-Picture

A minimal, **static**, frontend-only renderer that turns text into a 512×512
transparent WhatsApp-sticker image. No backend, no build step, no bundler — just
serve the folder.

Your bot (in any language) opens `render.html` with a headless browser
(Puppeteer or Playwright), waits for a ready signal, and screenshots a single
512×512 element. That screenshot is your sticker.

This is a ground-up rewrite of an older Vue + Puppeteer implementation that
brute-forced the font size in the live DOM (dozens of forced reflows per
request). The new version measures with canvas only — via
[`@chenglou/pretext`](https://github.com/chenglou/pretext) — binary-searches the
best font size in a single synchronous tick, and writes to the DOM exactly once.

## What's in the box

| File          | Purpose                                                              |
| ------------- | ------------------------------------------------------------------- |
| `render.html` | The render target bots open. Reads query params, fits, marks ready. |
| `index.html`  | A small local preview/editor for humans. Not used by bots.          |
| `ttp.js`      | Shared fit + render logic (ES module).                              |
| `ttp.css`     | Styling for the `#ttp` box and the outline technique.               |
| `fonts/`      | Impact + Apple/Noto color-emoji fonts.                              |
| `llms.txt`    | Machine-readable contract for LLM/agent integrators.                |

The only runtime network dependency is the Pretext ESM import from
`https://esm.sh/@chenglou/pretext` (not vendored, by design).

## Render contract

Open `render.html` with these query parameters:

| Param         | Default     | Meaning                                                        |
| ------------- | ----------- | ------------------------------------------------------------- |
| `text`        | —           | Text to render (all modes except `both`). `%0A` = newline.    |
| `mode`        | `center`    | Layout: `center`, `top`, `bottom`, `both`, `split`.           |
| `topText`     | —           | Top text — `mode=both` only.                                  |
| `bottomText`  | —           | Bottom text — `mode=both` only.                               |
| `color`       | `#ffffff`   | Fill color (any CSS color).                                   |
| `strokeColor` | `#000000`   | Outline color (any CSS color).                                |
| `variant`     | `ttp1`      | Visual style, orthogonal to `mode`. Only `ttp1` exists today. |

### Layout modes

| Mode     | What it does                                                              |
| -------- | ------------------------------------------------------------------------ |
| `center` | One block centered in the full box (default).                            |
| `top`    | One block in the top third (caption).                                    |
| `bottom` | One block in the bottom third (the classic "subtitle").                  |
| `both`   | `topText` + `bottomText`, top and bottom thirds, **one shared size**.    |
| `split`  | Auto-splits `text` into two width-balanced halves, top + bottom, shared size. |

> **Note:** this is a fresh contract, intentionally **not** backwards-compatible
> with the old API's parameter names.

Examples:

```
render.html?text=Hello%20World&color=%23ffcc00&strokeColor=%23000000
render.html?mode=bottom&text=em%20manuten%C3%A7%C3%A3o
render.html?mode=both&topText=one%20does%20not&bottomText=simply%20walk
render.html?mode=split&text=olha%20a%20velocidade%20disso
```

### Ready / error signaling

- On success, the `#ttp` element gets `data-ready="true"`. **Wait for this**
  before screenshotting.
- On failure, it gets `data-error="<message>"` and is **not** marked ready.

## Self-hosting

It's just static files. Pick any host:

```bash
# Python
python -m http.server 8080

# Node
npx serve .
```

Then point your bot at `http://localhost:8080/render.html?text=...`.

You can equally drop the folder on GitHub Pages, S3 + CloudFront, nginx, etc.

### Recommended headers

The fonts are large (the color-emoji fonts especially) and the assets never
change once deployed, so cache them hard and allow cross-origin loads:

```nginx
# Aggressive, immutable caching for static assets.
location ~* \.(ttf|js|css)$ {
    add_header Cache-Control "public, max-age=31536000, immutable";
    add_header Access-Control-Allow-Origin "*";
}
```

`Access-Control-Allow-Origin: *` keeps headless browsers loading from another
origin happy. (`render.html` itself can stay uncached if you prefer.)

## Integration

### Puppeteer

```js
import puppeteer from "puppeteer";

const browser = await puppeteer.launch();
const page = await browser.newPage();

const base = "http://localhost:8080/render.html";
const url = `${base}?text=${encodeURIComponent("Hello\nWorld 🎉")}`;

await page.goto(url, { waitUntil: "networkidle0" });
await page.waitForSelector('#ttp[data-ready="true"]');

const ttp = await page.$("#ttp");
const png = await ttp.screenshot({ omitBackground: true }); // Buffer (transparent PNG)

await browser.close();
```

### Playwright

```js
import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage();

const base = "http://localhost:8080/render.html";
const url = `${base}?text=${encodeURIComponent("Hello\nWorld 🎉")}`;

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector('#ttp[data-ready="true"]');

const ttp = page.locator("#ttp");
const png = await ttp.screenshot({ omitBackground: true }); // Buffer (transparent PNG)

await browser.close();
```

For a long-running bot, keep one browser (and ideally a warm page) alive and
just re-navigate per request — opening a fresh browser every time dominates the
cost.

## How the fit works

For a candidate font size, `ttp.js`:

1. `prepareWithSegments(text, \`${size}px "Impact", ...\`)` — one canvas analysis
   pass.
2. `measureLineStats(prepared, availWidth)` → `{ lineCount, maxLineWidth }`.
3. `totalHeight = lineCount * (size * 1.1)` (1.1× line-height).
4. Accept if `maxLineWidth` and `totalHeight` both fit the box (shrunk by the
   stroke width on each side).

A binary search over ~4–1000px finds the largest accepted size. None of this
touches the real DOM — the visible element is written once, at the end.

## License

[MIT](./LICENSE)
