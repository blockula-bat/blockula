/**
 * Pictures of a blackjack hand as PNG files: the SVG `@blockula/blackjack` draws, rendered with
 * resvg and the site's fonts. Deterministic: the same hand gives the same bytes.
 *
 * PLACEHOLDER: the signatures are final, the rendering is not (no fonts loaded yet).
 */
import { Resvg } from "@resvg/resvg-js";
import { POSTER_ALT, TABLE_WIDTH, altText, posterSvg, tableSvg, type TableSnapshot } from "@blockula/blackjack";

export interface Picture {
  /** The SVG document the PNG was rendered from. */
  svg: string;
  /** 1200 × 675 PNG. */
  png: Uint8Array;
  /** Alt text: every picture has one. */
  alt: string;
}

function png(svg: string): Uint8Array {
  return new Resvg(svg, { fitTo: { mode: "width", value: TABLE_WIDTH } }).render().asPng();
}

/** A hand's picture. */
export function renderTable(s: TableSnapshot): Picture {
  const svg = tableSvg(s);
  return { svg, png: png(svg), alt: altText(s) };
}

/** The table's poster: the picture a link to the table shows. */
export function renderPoster(): Picture {
  const svg = posterSvg();
  return { svg, png: png(svg), alt: POSTER_ALT };
}
