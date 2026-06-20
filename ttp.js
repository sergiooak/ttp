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

/**
 * Height of a top/bottom caption band as a fraction of the box. Two bands
 * (top + bottom) tile the box; a single top/bottom caption uses one band so it
 * reads as a caption rather than ballooning to fill the whole square.
 */
const BAND_FRACTION = 1/3;

/** Supported layout modes. Anything else falls back to `center`. */
export const MODES = ["center", "top", "bottom", "both", "split"];

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

/** Cached natural line ink ratio (full ascent+descent) of the primary font. */
let _lineRatio = null;

/**
 * Impact's natural per-line ink height as a multiple of the font size. The
 * glyph ink overhangs a `line-height: 1.0` box, so a stack of N lines is taller
 * than N*size*LINE_HEIGHT — we account for the overhang when checking height,
 * otherwise the top/bottom of tightly-packed blocks clip. Cached; call only
 * after fonts are loaded.
 * @returns {number}
 */
function lineInkRatio() {
  if (_lineRatio != null) return _lineRatio;
  if (!_measureCtx) return 1.2;
  _measureCtx.font = `100px ${CANVAS_FAMILY}`;
  const m = _measureCtx.measureText("MÁgjpqy");
  const asc = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent ?? 100;
  const desc = m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent ?? 20;
  _lineRatio = (asc + desc) / 100;
  return _lineRatio;
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
 * Does `text` fit a `boxW`x`boxH` box at the given font size? The stroke is
 * painted outside the glyphs, so we shrink the usable box by the stroke width
 * on every side before measuring. Empty text always fits.
 * @param {string} text
 * @param {number} size
 * @param {number} boxW
 * @param {number} boxH
 * @returns {boolean}
 */
function fitsInBox(text, size, boxW, boxH) {
  if (!text) return true;

  const stroke = strokeForSize(size);
  const availW = boxW - 2 * stroke;
  const availH = boxH - 2 * stroke;

  // No single word may be wider than the box — otherwise it overflows, since
  // the DOM never breaks inside a word.
  if (longestWordWidth(text, size) > availW) return false;

  const prepared = prepareWithSegments(text, `${size}px ${CANVAS_FAMILY}`, PRETEXT_OPTS);
  const { lineCount, maxLineWidth } = measureLineStats(prepared, availW);

  // Lines are spaced LINE_HEIGHT apart, but the first/last line's ink overhangs
  // its box, so the real stack height is (N-1) gaps + one full line of ink.
  const inkHeight = (lineCount - 1) * (size * LINE_HEIGHT) + size * lineInkRatio();

  return maxLineWidth <= availW && inkHeight <= availH;
}

/**
 * Binary-search the largest font size (px) at which EVERY block fits its own
 * box. With one block this is the plain single-block fit; with two it yields a
 * single shared size that fits both — what `both` and `split` layouts need.
 * Runs synchronously in one tick — no DOM, no waits.
 * @param {Array<{ text: string, boxW: number, boxH: number }>} blocks
 * @returns {number} font size in px
 */
export function fitFontSizeMulti(blocks) {
  const fitsAll = (size) => blocks.every((b) => fitsInBox(b.text, size, b.boxW, b.boxH));

  // Degenerate cases: even the smallest size overflows (one huge unbreakable
  // word), or the largest size still fits (very short text).
  if (!fitsAll(MIN_SIZE)) return MIN_SIZE;
  if (fitsAll(MAX_SIZE)) return MAX_SIZE;

  // Invariant: fitsAll(lo) === true, fitsAll(hi) === false.
  let lo = MIN_SIZE;
  let hi = MAX_SIZE;
  while (hi - lo > 0.5) {
    const mid = (lo + hi) / 2;
    if (fitsAll(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Largest font size at which `text` fits the full 512x512 box (center layout).
 * @param {string} text
 * @returns {number} font size in px
 */
export function fitFontSize(text) {
  return fitFontSizeMulti([{ text: String(text == null ? "" : text), boxW: BOX, boxH: BOX }]);
}

/**
 * Split `text` into two halves at the word boundary nearest the visual
 * midpoint (balanced by rendered width). Used by the `split` layout. If the
 * text has fewer than two words it cannot be split — it all goes on top.
 * @param {string} text
 * @returns {{ top: string, bottom: string }}
 */
export function splitByWidth(text) {
  const words = String(text == null ? "" : text)
    .split(/\s+/)
    .filter(Boolean);
  if (words.length < 2) return { top: words.join(" "), bottom: "" };

  // Word widths at an arbitrary reference size — only the ratio matters here.
  const REF = 100;
  const widths = words.map((w) => {
    _measureCtx.font = `${REF}px ${CANVAS_FAMILY}`;
    return _measureCtx.measureText(w + " ").width;
  });
  const total = widths.reduce((a, b) => a + b, 0);

  let cumulative = 0;
  let bestK = 1;
  let bestDiff = Infinity;
  for (let k = 1; k < words.length; k++) {
    cumulative += widths[k - 1];
    const diff = Math.abs(cumulative - (total - cumulative));
    if (diff < bestDiff) {
      bestDiff = diff;
      bestK = k;
    }
  }
  return {
    top: words.slice(0, bestK).join(" "),
    bottom: words.slice(bestK).join(" "),
  };
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
 * Resolve a layout mode + inputs into the text blocks to render and the boxes
 * to fit them in. Each block is anchored `top`, `bottom`, or `center`.
 * @param {string} mode
 * @param {{ text: string, topText: string, bottomText: string }} inputs
 * @returns {{ blocks: Array<{ text: string, anchor: string }>,
 *             boxes: Array<{ text: string, boxW: number, boxH: number }> }}
 */
function resolveLayout(mode, { text, topText, bottomText }) {
  const band = BOX * BAND_FRACTION;
  switch (mode) {
    case "top":
      return {
        blocks: [{ text, anchor: "top" }],
        boxes: [{ text, boxW: BOX, boxH: band }],
      };
    case "bottom":
      return {
        blocks: [{ text, anchor: "bottom" }],
        boxes: [{ text, boxW: BOX, boxH: band }],
      };
    case "both": {
      const blocks = [
        { text: topText, anchor: "top" },
        { text: bottomText, anchor: "bottom" },
      ];
      return { blocks, boxes: blocks.map((b) => ({ text: b.text, boxW: BOX, boxH: band })) };
    }
    case "split": {
      const { top, bottom } = splitByWidth(text);
      const blocks = [
        { text: top, anchor: "top" },
        { text: bottom, anchor: "bottom" },
      ];
      return { blocks, boxes: blocks.map((b) => ({ text: b.text, boxW: BOX, boxH: band })) };
    }
    case "center":
    default:
      return {
        blocks: [{ text, anchor: "center" }],
        boxes: [{ text, boxW: BOX, boxH: BOX }],
      };
  }
}

/**
 * Build one anchored text block: the `.ttp-text` wrapper holding the two
 * overlapping spans that render the outline technique (a back span drawn as
 * outline-only via -webkit-text-stroke, a front span with the solid fill).
 * @param {string} text
 * @param {string} anchor  'top' | 'bottom' | 'center'
 * @returns {HTMLDivElement}
 */
function makeBlock(text, anchor) {
  const block = document.createElement("div");
  block.className = `ttp-block ttp-${anchor}`;

  const wrap = document.createElement("div");
  wrap.className = "ttp-text";

  const strokeSpan = document.createElement("span");
  strokeSpan.className = "ttp-stroke";
  strokeSpan.setAttribute("aria-hidden", "true");
  // textContent (not innerHTML) — input is untrusted query-string data.
  strokeSpan.textContent = text;

  const fillSpan = document.createElement("span");
  fillSpan.className = "ttp-fill";
  fillSpan.textContent = text;

  // Stroke first (painted behind), fill second (painted on top).
  wrap.appendChild(strokeSpan);
  wrap.appendChild(fillSpan);
  block.appendChild(wrap);
  return block;
}

/**
 * Render text into the #ttp element: pick the layout, fit a single shared font
 * size, build the block(s), and mark the element ready for an external
 * screenshot. The DOM is written once, at the end.
 *
 * @param {HTMLElement} el  the #ttp element
 * @param {Object} opts
 * @param {string} [opts.text='']                 text for center/top/bottom/split
 * @param {string} [opts.topText='']              top text for `both`
 * @param {string} [opts.bottomText='']           bottom text for `both`
 * @param {string} [opts.mode='center']           center|top|bottom|both|split
 * @param {string} [opts.color='#ffffff']         fill color
 * @param {string} [opts.strokeColor='#000000']   outline color
 * @returns {Promise<{ size: number, stroke: number, mode: string,
 *                     blocks: Array<{ anchor: string, text: string }> }>}
 */
export async function render(
  el,
  { text = "", topText = "", bottomText = "", mode = "center", color = "#ffffff", strokeColor = "#000000" } = {}
) {
  el.removeAttribute("data-ready");

  await ensureFontsReady();

  const resolvedMode = MODES.includes(mode) ? mode : "center";
  const { blocks, boxes } = resolveLayout(resolvedMode, {
    text: String(text == null ? "" : text),
    topText: String(topText == null ? "" : topText),
    bottomText: String(bottomText == null ? "" : bottomText),
  });

  const size = fitFontSizeMulti(boxes);
  const stroke = strokeForSize(size);
  const avail = BOX - 2 * stroke;

  // CSS custom properties drive size/stroke/colors so fill and stroke stay
  // perfectly aligned, and so both blocks share the same fitted size.
  el.style.setProperty("--size", `${size}px`);
  el.style.setProperty("--stroke", `${stroke}px`);
  el.style.setProperty("--avail", `${avail}px`);
  el.style.setProperty("--band", `${BOX * BAND_FRACTION}px`);
  el.style.setProperty("--line-height", String(LINE_HEIGHT));
  el.style.setProperty("--fill", color);
  el.style.setProperty("--stroke-color", strokeColor);

  el.replaceChildren(...blocks.map((b) => makeBlock(b.text, b.anchor)));

  el.setAttribute("data-ready", "true");
  return { size, stroke, mode: resolvedMode, blocks: blocks.map((b) => ({ anchor: b.anchor, text: b.text })) };
}
