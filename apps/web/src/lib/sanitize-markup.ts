import sanitizeHtml, { type IOptions } from 'sanitize-html'

/**
 * CMS fields that hold markup (icons, chart and signature SVGs, banner text)
 * are rendered with `set:html`, and the marketing CSP allows inline script.
 * Whoever can edit those fields must not be able to run script on this
 * origin, so every such field goes through one of these allow-lists.
 */

const SVG_TAGS = [
	'svg',
	'g',
	'path',
	'circle',
	'ellipse',
	'line',
	'polyline',
	'polygon',
	'rect',
	'text',
	'tspan',
	'defs',
	'linearGradient',
	'radialGradient',
	'stop',
	'clipPath',
	'mask',
	'title',
	'desc',
]

const SVG_ATTRIBUTES = [
	'xmlns',
	'viewBox',
	'width',
	'height',
	'fill',
	'fill-opacity',
	'fill-rule',
	'clip-rule',
	'clip-path',
	'mask',
	'stroke',
	'stroke-width',
	'stroke-linecap',
	'stroke-linejoin',
	'stroke-dasharray',
	'stroke-dashoffset',
	'stroke-miterlimit',
	'stroke-opacity',
	'opacity',
	'transform',
	'd',
	'cx',
	'cy',
	'r',
	'rx',
	'ry',
	'x',
	'y',
	'x1',
	'x2',
	'y1',
	'y2',
	'dx',
	'dy',
	'points',
	'offset',
	'stop-color',
	'stop-opacity',
	'gradientUnits',
	'gradientTransform',
	'preserveAspectRatio',
	'text-anchor',
	'dominant-baseline',
	'font-size',
	'font-weight',
	'font-family',
	'id',
	'class',
	'role',
	'aria-hidden',
	'aria-label',
	'focusable',
]

const SVG_OPTIONS: IOptions = {
	allowedTags: SVG_TAGS,
	allowedAttributes: { '*': SVG_ATTRIBUTES },
	// No href anywhere (no <a>, no <use>, no <image>), so no scheme is needed.
	allowedSchemes: [],
	// SVG is case-sensitive (viewBox, linearGradient).
	parser: { lowerCaseTags: false, lowerCaseAttributeNames: false },
}

const INLINE_HTML_OPTIONS: IOptions = {
	allowedTags: ['b', 'strong', 'i', 'em', 'u', 's', 'br', 'span', 'a', 'code'],
	allowedAttributes: {
		a: ['href', 'target', 'rel'],
		span: ['class'],
	},
	allowedSchemes: ['http', 'https', 'mailto', 'tel'],
	transformTags: {
		a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }),
	},
}

/** An icon, chart or signature SVG from the CMS, reduced to drawing markup. */
export function sanitizeSvg(markup: unknown): string {
	if (typeof markup !== 'string' || !markup.trim()) return ''
	return sanitizeHtml(markup, SVG_OPTIONS)
}

/** Short CMS text with basic inline formatting and links (the banner). */
export function sanitizeInlineHtml(markup: unknown): string {
	if (typeof markup !== 'string' || !markup.trim()) return ''
	return sanitizeHtml(markup, INLINE_HTML_OPTIONS)
}
