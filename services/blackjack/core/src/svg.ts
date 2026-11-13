/**
 * A hand drawn as SVG: browser-safe strings, no dependencies, the same bytes for the same hand.
 * The table page shows them inline; `@blockula/blackjack-render` turns them into PNG files.
 *
 * PLACEHOLDER ART: the signatures are final, the drawing is not.
 */
import { fang } from "./codec.js";
import { RANKS, SUITS, cardLabel, suit } from "./rules.js";
import { phaseWords, totalWords, type TableSnapshot } from "./snapshot.js";

export const TABLE_WIDTH = 1200;
export const TABLE_HEIGHT = 675;
export const CARD_WIDTH = 250;
export const CARD_HEIGHT = 350;

/** The site's colors (web/app/globals.css). */
export const THEME = Object.freeze({ paper: "#ece3cd", paperHi: "#f4eedf", paperLo: "#e1d6ba", ink: "#17120f", inkSoft: "#3b332c", blood: "#8d1418", bloodHi: "#a91c20" });

/** Font families the drawing names. The table page passes the families its own stylesheet loaded. */
export interface SvgFonts {
  /** Blackletter, for the masthead. */
  display: string;
  serif: string;
  caps: string;
  mono: string;
}

export const DEFAULT_FONTS: SvgFonts = Object.freeze({ display: "UnifrakturMaguntia", serif: "EB Garamond", caps: "IM Fell English SC", mono: "Courier Prime" });

export interface SvgOptions {
  fonts?: Partial<SvgFonts>;
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A card's face, as a fragment drawn in a 250 × 350 box at the origin. */
export function cardFaceFragment(card: number, opts: SvgOptions = {}): string {
  const f = { ...DEFAULT_FONTS, ...opts.fonts };
  const color = suit(card) === 1 || suit(card) === 2 ? THEME.blood : THEME.ink;
  const label = cardLabel(card);
  return `<rect width="250" height="350" rx="14" fill="${THEME.paperHi}" stroke="${THEME.ink}" stroke-width="3"/><text x="20" y="56" font-family="${esc(f.serif)}" font-size="48" fill="${color}">${esc(RANKS[card % 13])}</text><text x="125" y="215" text-anchor="middle" font-family="${esc(f.serif)}" font-size="120" fill="${color}">${SUITS[suit(card)]}</text><title>${esc(label)}</title>`;
}

/** A card's back (the Blockula bat), as a fragment drawn in a 250 × 350 box at the origin. */
export function cardBackFragment(): string {
  return `<rect width="250" height="350" rx="14" fill="${THEME.ink}" stroke="${THEME.ink}" stroke-width="3"/><rect x="14" y="14" width="222" height="322" rx="8" fill="none" stroke="${THEME.blood}" stroke-width="3"/><path d="M125 150 l-70 -30 20 50 -30 10 80 30 80 -30 -30 -10 20 -50z" fill="${THEME.blood}"/><circle cx="125" cy="170" r="22" fill="${THEME.ink}"/>`;
}

const standalone = (inner: string): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" width="${CARD_WIDTH}" height="${CARD_HEIGHT}">${inner}</svg>`;

/** One card's face as its own SVG document. */
export function cardFaceSvg(card: number, opts: SvgOptions = {}): string {
  return standalone(cardFaceFragment(card, opts));
}

/** A card's back as its own SVG document. */
export function cardBackSvg(): string {
  return standalone(cardBackFragment());
}

/** The whole table for one hand: 1200 × 675, the dealer's cards above the player's, the footer with totals, bet, hand id and tx id. */
export function tableSvg(s: TableSnapshot, opts: SvgOptions = {}): string {
  const f = { ...DEFAULT_FONTS, ...opts.fonts };
  const row = (cards: readonly number[], hidden: boolean, y: number): string => {
    const parts = cards.map((c, i) => `<g transform="translate(${80 + i * 130} ${y}) scale(0.6)">${cardFaceFragment(c, opts)}</g>`);
    if (hidden) parts.push(`<g transform="translate(${80 + cards.length * 130} ${y}) scale(0.6)">${cardBackFragment()}</g>`);
    return parts.join("");
  };
  const tx = s.txId ? `  tx ${esc(s.txId.slice(0, 10))}…` : "";
  const footer = `Dealer ${s.dealerCards.length ? totalWords(s.dealerCards) : "–"}  ·  Player ${s.playerCards.length ? totalWords(s.playerCards) : "–"}  ·  Bet ${fang(s.stake)} FANG  ·  Hand ${s.gameId}${tx}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TABLE_WIDTH} ${TABLE_HEIGHT}" width="${TABLE_WIDTH}" height="${TABLE_HEIGHT}"><rect width="${TABLE_WIDTH}" height="${TABLE_HEIGHT}" fill="${THEME.paper}"/><text x="80" y="70" font-family="${esc(f.display)}" font-size="54" fill="${THEME.ink}">Blockula Blackjack</text>${row(s.dealerCards, s.holeHidden, 100)}${row(s.playerCards, false, 340)}<text x="80" y="600" font-family="${esc(f.serif)}" font-size="34" fill="${THEME.blood}">${esc(phaseWords(s))}</text><text x="80" y="645" font-family="${esc(f.mono)}" font-size="22" fill="${THEME.inkSoft}">${esc(footer)}</text></svg>`;
}

/** The table with no hand on it: the picture a link to the table shows. */
export function posterSvg(opts: SvgOptions = {}): string {
  const f = { ...DEFAULT_FONTS, ...opts.fonts };
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TABLE_WIDTH} ${TABLE_HEIGHT}" width="${TABLE_WIDTH}" height="${TABLE_HEIGHT}"><rect width="${TABLE_WIDTH}" height="${TABLE_HEIGHT}" fill="${THEME.paper}"/><text x="600" y="300" text-anchor="middle" font-family="${esc(f.display)}" font-size="110" fill="${THEME.ink}">Blockula Blackjack</text><text x="600" y="380" text-anchor="middle" font-family="${esc(f.serif)}" font-size="40" fill="${THEME.blood}">A game played with FANG</text><g transform="translate(525 420) scale(0.6)">${cardBackFragment()}</g></svg>`;
}

/** Alt text for the poster. */
export const POSTER_ALT = "Blockula Blackjack: a game played with FANG. A playing card lies face down, its back a black bat with red wings.";
