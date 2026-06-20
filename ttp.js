// ttp.js — shared Text-To-Picture render/fit logic.
//
// Font fitting is done entirely with canvas measurement via Pretext
// (https://github.com/chenglou/pretext). The real DOM is never used for
// trial-and-error: we binary-search the largest font size that fits a 512x512
// box using Pretext's measureLineStats, then write the result to the element
// exactly once.
//
// Loaded from CDN, never vendored — see render.html / index.html.
import {
  prepareWithSegments,
  measureLineStats,
} from "https://esm.sh/@chenglou/pretext";

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

/** Render target is a fixed 512x512 square (WhatsApp sticker size). */
export const BOX = 512;

/** Line-height multiplier applied to the font size (matches CSS line-height). */
const LINE_HEIGHT = 1.0;

/** Binary-search bounds for the font size, in px. */
const MIN_SIZE = 4;
const MAX_SIZE = 1000;

/**
 * Canvas font-shorthand family list. Impact for letters, the color-emoji fonts
 * as fallback so emoji glyph widths are measured with the right metrics.
 * Must stay in sync with the `font-family` in ttp.css.
 */
const CANVAS_FAMILY = '"Impact", "AppleColorEmoji", "NotoColorEmoji"';

/** Pretext options: respect explicit newlines, wrap on word boundaries. */
const PRETEXT_OPTS = { whiteSpace: "pre-wrap", wordBreak: "normal" };

/** Reused canvas 2D context for measuring individual word widths. */
const _measureCtx =
  typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;

/**
 * Width (px) of the widest whitespace-delimited word at a given font size.
 *
 * Pretext, when a single word is wider than the box, breaks it at grapheme
 * boundaries to keep `maxLineWidth` within bounds — so measureLineStats can
 * never report an oversized word. The DOM does NOT break words
 * (overflow-wrap: normal), so we must reject such sizes ourselves. We measure
 * with canvas, the same engine Pretext (and the browser) use.
 * @param {string} text
 * @param {number} size
 * @returns {number}
 */
function longestWordWidth(text, size) {
  if (!_measureCtx) return 0;
  _measureCtx.font = `${size}px ${CANVAS_FAMILY}`;
  let max = 0;
  for (const word of text.split(/\s+/)) {
    if (!word) continue;
    const w = _measureCtx.measureText(word).width;
    if (w > max) max = w;
  }
  return max;
}

// ----------------------------------------------------------------------------
// Fit logic (pure, synchronous, canvas-only)
// ----------------------------------------------------------------------------

/**
 * Outline thickness for a given font size, in px. Same curve as the old
 * implementation: 7.5% of the size, clamped to [7.5, 22].
 * @param {number} size
 * @returns {number}
 */
export function strokeForSize(size) {
  return Math.min(Math.max(size * 0.075, 7.5), 22);
}

/**
 * Does `text` fit the 512x512 box at the given font size? The stroke is painted
 * outside the glyphs, so we shrink the usable box by the stroke width on every
 * side before measuring.
 * @param {string} text
 * @param {number} size
 * @returns {boolean}
 */
function fitsAtSize(text, size) {
  const stroke = strokeForSize(size);
  const avail = BOX - 2 * stroke;

  // No single word may be wider than the box — otherwise it overflows, since
  // the DOM never breaks inside a word.
  if (longestWordWidth(text, size) > avail) return false;

  const prepared = prepareWithSegments(text, `${size}px ${CANVAS_FAMILY}`, PRETEXT_OPTS);
  const { lineCount, maxLineWidth } = measureLineStats(prepared, avail);
  const totalHeight = lineCount * (size * LINE_HEIGHT);

  return maxLineWidth <= avail && totalHeight <= avail;
}

/**
 * Binary-search the largest font size (px) at which `text` fits the box.
 * Runs synchronously in one tick — no DOM, no waits.
 * @param {string} text
 * @returns {number} font size in px
 */
export function fitFontSize(text) {
  // Degenerate cases: even the smallest size overflows (one huge unbreakable
  // word), or the largest size still fits (very short text).
  if (!fitsAtSize(text, MIN_SIZE)) return MIN_SIZE;
  if (fitsAtSize(text, MAX_SIZE)) return MAX_SIZE;

  // Invariant: fitsAtSize(lo) === true, fitsAtSize(hi) === false.
  let lo = MIN_SIZE;
  let hi = MAX_SIZE;
  while (hi - lo > 0.5) {
    const mid = (lo + hi) / 2;
    if (fitsAtSize(text, mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

// ----------------------------------------------------------------------------
// Rendering (touches the DOM exactly once, at the end)
// ----------------------------------------------------------------------------

/**
 * Make sure the local @font-face fonts are actually loaded before we measure
 * with canvas — otherwise Pretext would measure a fallback font and pick the
 * wrong size.
 * @returns {Promise<void>}
 */
export async function ensureFontsReady() {
  await Promise.all([
    document.fonts.load('1em "Impact"'),
    document.fonts.load('1em "AppleColorEmoji"'),
    document.fonts.load('1em "NotoColorEmoji"'),
  ]).catch(() => {});
  await document.fonts.ready;
}

/**
 * Render `text` into the #ttp element: fit the font, apply colors, and mark the
 * element ready for an external screenshot.
 *
 * The element is expected to contain the markup created by `buildTarget` (a
 * `.ttp-text` wrapper holding `.ttp-stroke` + `.ttp-fill` spans).
 *
 * @param {HTMLElement} el  the #ttp element
 * @param {Object} opts
 * @param {string} opts.text
 * @param {string} [opts.color='#ffffff']        fill color
 * @param {string} [opts.strokeColor='#000000']  outline color
 * @returns {Promise<{ size: number, stroke: number }>}
 */
export async function render(el, { text, color = "#ffffff", strokeColor = "#000000" }) {
  el.removeAttribute("data-ready");

  await ensureFontsReady();

  const value = text == null ? "" : String(text);
  const size = fitFontSize(value);
  const stroke = strokeForSize(size);
  const avail = BOX - 2 * stroke;

  // One write to the DOM. CSS custom properties drive size/stroke/colors so the
  // fill and stroke spans stay perfectly aligned.
  el.style.setProperty("--size", `${size}px`);
  el.style.setProperty("--stroke", `${stroke}px`);
  el.style.setProperty("--avail", `${avail}px`);
  el.style.setProperty("--line-height", String(LINE_HEIGHT));
  el.style.setProperty("--fill", color);
  el.style.setProperty("--stroke-color", strokeColor);

  const fillEl = el.querySelector(".ttp-fill");
  const strokeEl = el.querySelector(".ttp-stroke");
  // textContent (not innerHTML) — input is untrusted query-string data.
  fillEl.textContent = value;
  strokeEl.textContent = value;

  el.setAttribute("data-ready", "true");
  return { size, stroke };
}

/**
 * Create the inner span structure inside the #ttp element. Two overlapping
 * spans render the outline technique: a back span drawn as outline-only
 * (-webkit-text-stroke, transparent fill) and a front span with the solid fill.
 *
 * Idempotent — safe to call before each render.
 * @param {HTMLElement} el  the #ttp element
 */
export function buildTarget(el) {
  if (el.querySelector(".ttp-text")) return;
  const wrap = document.createElement("div");
  wrap.className = "ttp-text";

  const strokeSpan = document.createElement("span");
  strokeSpan.className = "ttp-stroke";
  strokeSpan.setAttribute("aria-hidden", "true");

  const fillSpan = document.createElement("span");
  fillSpan.className = "ttp-fill";

  // Stroke first (painted behind), fill second (painted on top).
  wrap.appendChild(strokeSpan);
  wrap.appendChild(fillSpan);
  el.appendChild(wrap);
}
