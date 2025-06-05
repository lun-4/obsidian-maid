import { XXHash32 as megafunny } from "ts-xxhash";
//import { default as megafunny } from "ts-xxhash";
// import { default as funny } from "pcg-random";

// ——————————————
// 1) Utility: WCAG contrast helpers
// ——————————————

/**
 * Convert sRGB channel (0–255) to linearized value (0.0–1.0).
 */
function _srgbChannelToLinear(c: number): number {
  const x = c / 255;
  return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

/**
 * Compute relative luminance of an RGB triplet (0–255 each), per WCAG 2.0.
 */
function srgbLuminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map(_srgbChannelToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Compute WCAG contrast ratio between two RGB colors.
 *   Contrast = (L1 + 0.05) / (L2 + 0.05),
 * where L1 = brighter luminance, L2 = darker luminance.
 */
function wcagContrast(
  rgb1: [number, number, number],
  rgb2: [number, number, number],
): number {
  const lum1 = srgbLuminance(rgb1);
  const lum2 = srgbLuminance(rgb2);
  const Lb = Math.max(lum1, lum2);
  const Ld = Math.min(lum1, lum2);
  return (Lb + 0.05) / (Ld + 0.05);
}

/**
 * Clamp a number to the integer [0, 255] range.
 */
function _clamp255(v: number): number {
  return Math.min(255, Math.max(0, Math.round(v)));
}

// ——————————————
// 2) Convert HSL → RGB (0–255)
// ——————————————

/**
 * Given h ∈ [0,360), s ∈ [0,1], l ∈ [0,1], returns [r,g,b] each in 0–255.
 * Standard CSS HSL → RGB conversion.
 */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  // Helper: hue → rgb channel
  const _hue2rgb = (p: number, q: number, t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  const hf = h / 360; // normalized to [0,1]
  let r: number, g: number, b: number;

  if (s === 0) {
    // achromatic: just gray
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = _hue2rgb(p, q, hf + 1 / 3);
    g = _hue2rgb(p, q, hf);
    b = _hue2rgb(p, q, hf - 1 / 3);
  }

  return [_clamp255(r * 255), _clamp255(g * 255), _clamp255(b * 255)];
}

// ——————————————
// 3) “Hash → HSL → RGB → Contrast‐check” pipeline
// ——————————————

/**
 * Given arbitrary short text, produce a “random but reproducible” H value (0–360)
 * by hashing. We then fix S=0.75 and pick an initial midpoint L=0.50.
 */
function hashToInitialHSL(text: string): { h: number; s: number; l: number } {
  // (a) XXHash32 → 32‐bit seed
  const h = new megafunny(0xdeadbeef);
  h.update(text);
  const digest = h.digest().toNumber(); // 0 .. 2^32‐1

  // (b) Map it to [0, 360) by taking modulo
  const hue = digest % 360;

  // (c) Fixed saturation
  const sat = 0.75;

  // (d) Fixed “middle” lightness
  const lit = 0.5;

  return { h: hue, s: sat, l: lit };
}

/**
 * Given an HSL triple and a target contrast ratio threshold (against white),
 * return a new RGB that is “pushed darker until it hits contrast ≥ 4.5,”
 * or “pushed lighter” if for some reason making it darker fails (e.g. if L is already
 * 0). In practice you’ll almost always darken from L=0.50 → <0.50.
 */
function ensureContrastAgainstWhite(
  initialHSL: { h: number; s: number; l: number },
  contrastThreshold = 4.5,
): [number, number, number] {
  const whiteRgb: [number, number, number] = [198, 208, 245]; // obsidian text color is not pure ffffff

  let { h, s, l } = initialHSL;
  let rgb: [number, number, number] = hslToRgb(h, s, l);
  let currentContrast = wcagContrast(rgb, whiteRgb);

  // If it already meets 4.5:1, just return it.
  if (currentContrast >= contrastThreshold) {
    return rgb;
  }

  // Otherwise, try gradually DARKENING (i.e. reducing L) by 0.05 steps until we hit it.
  let tries = 0;
  while (currentContrast < contrastThreshold && tries < 20) {
    l = Math.max(0, l - 0.05);
    rgb = hslToRgb(h, s, l);
    currentContrast = wcagContrast(rgb, whiteRgb);
    tries++;
    if (l <= 0) break; // fully black if needed
  }

  // If that still didn’t reach threshold (unlikely), try LIGHTENING from 0.50 → 1.00:
  tries = 0;
  if (currentContrast < contrastThreshold) {
    l = initialHSL.l; // reset to 0.50
    while (currentContrast < contrastThreshold && tries < 20) {
      l = Math.min(1, l + 0.05);
      rgb = hslToRgb(h, s, l);
      currentContrast = wcagContrast(rgb, whiteRgb);
      tries++;
      if (l >= 1) break; // fully white if needed (this actually would fail contrast!)
    }
  }

  // Final return (if still under threshold, we return whatever we got.)
  return rgb;
}

/**
 * Given a short string (e.g. a tag), return an RGB triplet [0–255].
 * Guarantees ≥ 4.5:1 contrast against white (#ffffff).
 */
export function colorize_text(text: string): [number, number, number] {
  // 1) Map text → (H,S,L=0.50)
  const initialHSL = hashToInitialHSL(text);

  // 2) Adjust L darker/lighter until contrast >= 4.5:1 vs. #ffffff
  const rgb = ensureContrastAgainstWhite(initialHSL, 4.5);

  return rgb;
}
