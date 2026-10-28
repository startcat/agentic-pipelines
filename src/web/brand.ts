/**
 * The brand mark, the same one the landing uses: a cream tile with the
 * terminal-window glyph in the accent. Inline SVG and not a file, because it
 * is drawn twice per page (the header and the favicon) and a request for a
 * 600-byte icon is a request the viewer doesn't need to make.
 *
 * The colors are FIXED, not tokens: it is a logo, and it reads the same on the
 * dark page and on the cream one — exactly as on the landing.
 *
 * Glyph: "terminal-window" from Phosphor Icons (https://phosphoricons.com),
 * MIT license, Copyright (c) 2020 Phosphor Icons. The transform scales its
 * 256-unit grid and centers it on the 512-unit tile.
 */
export const BRAND_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">' +
  '<rect x="6" y="6" width="500" height="500" rx="114" fill="#FFFDF9" stroke="#D3C3AE" stroke-width="12"/>' +
  '<path transform="translate(113.8 113.8) scale(1.1111)" fill="#C54A22" d="M72.5,150.63,100.79,128,72.5,105.37a12,12,0,1,1,15-18.74l40,32a12,12,0,0,1,0,18.74l-40,32a12,12,0,0,1-15-18.74ZM144,172h32a12,12,0,0,0,0-24H144a12,12,0,0,0,0,24ZM236,56V200a20,20,0,0,1-20,20H40a20,20,0,0,1-20-20V56A20,20,0,0,1,40,36H216A20,20,0,0,1,236,56Zm-24,4H44V196H212Z"/>' +
  '</svg>';

/**
 * The same SVG as a `data:` URI for `<link rel="icon">`. Percent-encoded and
 * not base64: it stays readable in the page source, and `encodeURIComponent`
 * takes care of the `#` of the colors, which would otherwise end the URI.
 */
export const BRAND_FAVICON = `data:image/svg+xml,${encodeURIComponent(BRAND_ICON_SVG)}`;
