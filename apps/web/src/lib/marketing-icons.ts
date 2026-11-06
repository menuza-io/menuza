import { sanitizeSvg } from './sanitize-markup'

/**
 * Maps marketing block CMS icon keys (from ICON_OPTIONS) to inline SVG markup.
 */

const ICON_PATHS: Record<string, string> = {
	zap: '<path d="M13 2L3 14h8l-1 8 10-12h-8l1-8z" />',
	shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />',
	users:
		'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />',
	chart:
		'<path d="M3 3v18h18" /><path d="M18 17V9" /><path d="M13 17V5" /><path d="M8 17v-3" />',
	code: '<path d="M8 9l3 3-3 3" /><path d="M13 15h3" /><path d="M3 4m0 2a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />',
	globe:
		'<circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" /><path d="M2 12h20" />',
	heart:
		'<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />',
	star: '<path d="m12 2 3.09 6.26L20 9.27l-5 4.87L15.18 22 12 18.77 8.82 22 9 14.14l-5-4.87 4.91-1.01L12 2z" />',
	check: '<path d="M20 6 9 17l-5-5" />',
	lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />',
	clock: '<circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" />',
	cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9.5h1.79a4.5 4.5 0 1 1 0 9Z" />',
	database:
		'<ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14a9 3 0 0 0 18 0V5" /><path d="M3 12a9 3 0 0 0 18 0" />',
	sparkles:
		'<path d="m12 3-1.9 3.8-3.8 1.9 3.8 1.9L12 16l1.9-3.8 3.8-1.9-3.8-1.9L12 3Z" /><path d="M5 3v4" /><path d="M19 17v4" /><path d="M3 5h4" /><path d="M17 19h4" />',
	layers:
		'<path d="m12 2 8 4.5v7L12 20l-8-4.5v-7L12 2Z" /><path d="m4.5 9.5 12 14l7.5-4.5" /><path d="M20 13.5 12 18l-8-4.5" />',
}

function marketingIconSvg(paths: string, size = 20): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`
}

/** CMS icon key, raw SVG, or undefined → safe SVG HTML for set:html. */
export function resolveMarketingIcon(
	icon: string | undefined | null,
	size = 20,
): string | undefined {
	const trimmed = icon?.trim()
	if (!trimmed) return undefined
	if (trimmed.startsWith('<')) return sanitizeSvg(trimmed) || undefined

	const paths = ICON_PATHS[trimmed.toLowerCase()]
	return paths ? marketingIconSvg(paths, size) : undefined
}
