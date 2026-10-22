import { type PublicOrganization, type PublicSiteTheme } from './types.ts'

const STYLE_ID = 'org-theme'
const FONT_STYLE_ID = 'org-fonts'

/**
 * Preset site fonts are fetched at build time by the sites app and are not
 * available offline here, so presets resolve to the device UI font (identical
 * metrics every night, no layout shift). Uploaded brand fonts are real files:
 * the service worker caches them and they apply exactly as on the website.
 */
const FONT_FORMATS = new Set(['woff2', 'woff', 'truetype', 'opentype'])

/** A CSS string literal that cannot be closed early, whatever the value holds. */
const cssString = (value: string) =>
	`'${value.replace(/[\\'\n\r\f]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)}'`

/** Only a web address or a path on this host may be loaded as a font. */
const safeFontUrl = (url: string): string | null =>
	/^(https?:\/\/|\/(?!\/))/i.test(url) ? url : null

export function fontFaceCss(theme: PublicSiteTheme): string {
	const face = (
		family: string,
		font?: PublicSiteTheme['headingCustomFont'],
	) => {
		const url = font?.url ? safeFontUrl(font.url) : null
		if (!url || !font || !FONT_FORMATS.has(font.format)) return ''
		return `@font-face{font-family:${cssString(family)};src:url(${cssString(url)}) format(${cssString(font.format)});font-display:swap}`
	}
	return (
		face('SiteHeading', theme.headingCustomFont) +
		face('SiteBody', theme.bodyCustomFont)
	)
}

export function applyTheme(org: PublicOrganization | null): void {
	const root = document.documentElement
	const theme = org?.theme
	let style = document.getElementById(STYLE_ID)
	let fonts = document.getElementById(FONT_STYLE_ID)
	if (!theme) {
		style?.remove()
		fonts?.remove()
		root.removeAttribute('data-heading-font')
		root.removeAttribute('data-body-font')
		return
	}
	if (!style) {
		style = document.createElement('style')
		style.id = STYLE_ID
		document.head.append(style)
	}
	style.textContent = theme.css
	if (!fonts) {
		fonts = document.createElement('style')
		fonts.id = FONT_STYLE_ID
		document.head.append(fonts)
	}
	fonts.textContent = fontFaceCss(theme)
	root.dataset.headingFont =
		theme.headingFont === 'custom' && theme.headingCustomFont?.url
			? 'custom'
			: 'system'
	root.dataset.bodyFont =
		theme.bodyFont === 'custom' && theme.bodyCustomFont?.url
			? 'custom'
			: 'system'

	const apply = (dark: boolean) => root.classList.toggle('dark', dark)
	if (theme.mode === 'dark') apply(true)
	else if (theme.mode === 'light') apply(false)
	else {
		const mq = window.matchMedia('(prefers-color-scheme: dark)')
		apply(mq.matches)
	}
	const primary = getComputedStyle(root).getPropertyValue('--primary').trim()
	const meta =
		document.querySelector('meta[name="theme-color"]') ??
		Object.assign(document.createElement('meta'), { name: 'theme-color' })
	if (!meta.parentElement) document.head.append(meta)
	const bg = getComputedStyle(root).getPropertyValue('--background').trim()
	meta.setAttribute('content', bg || primary || '#ffffff')
}
