/**
 * Shared website link model for the page builder inspector and public Sites.
 *
 * Stored values may be a legacy string href or a structured SiteLink object.
 * Always resolve through `resolveSiteLink` before rendering an <a>.
 */

export const SITE_LINK_TYPES = [
	'url',
	'page',
	'email',
	'phone',
	'file',
] as const

export type SiteLinkType = (typeof SITE_LINK_TYPES)[number]

export const SITE_LINK_PRELOADS = [
	'default',
	'prefetch',
	'prerender',
	'none',
] as const

export type SiteLinkPreload = (typeof SITE_LINK_PRELOADS)[number]

export type SiteLinkOpenIn = 'self' | 'blank'

export type SiteLinkFile = {
	url: string
	name: string
	size?: number
	width?: number
	height?: number
}

export type SitePageRef = {
	id: string
	slug: string
	isHomePage?: boolean
}

export type SiteLink = {
	type: SiteLinkType
	href?: string
	url?: string
	openIn?: SiteLinkOpenIn
	preload?: SiteLinkPreload
	pageId?: string
	pageSlug?: string
	email?: string
	subject?: string
	phone?: string
	file?: SiteLinkFile
}

export type SiteLinkInput = unknown

export type ResolvedSiteLink = {
	href: string
	target?: '_blank'
	rel?: string
}

export const SITE_LINK_RESERVED_PATHS = new Set([
	'login',
	'profile',
	'verify',
	'complete-name',
	'reserve',
	'experiences',
])

const DEFAULT_LINK: SiteLink = {
	type: 'url',
	url: '',
	href: '#',
	openIn: 'self',
	preload: 'default',
}

export function isSiteLinkType(value: unknown): value is SiteLinkType {
	return (
		typeof value === 'string' &&
		(SITE_LINK_TYPES as readonly string[]).includes(value)
	)
}

export function isSiteLinkPreload(value: unknown): value is SiteLinkPreload {
	return (
		typeof value === 'string' &&
		(SITE_LINK_PRELOADS as readonly string[]).includes(value)
	)
}

const SLASH = 47 // '/'

function trimChar(
	path: string,
	charCode: number,
	edges: 'start' | 'end' | 'both',
) {
	let start = 0
	let end = path.length
	if (edges !== 'end') {
		while (start < end && path.charCodeAt(start) === charCode) start += 1
	}
	if (edges !== 'start') {
		while (end > start && path.charCodeAt(end - 1) === charCode) end -= 1
	}
	return start === 0 && end === path.length ? path : path.slice(start, end)
}

export function getSitePageHref(page: SitePageRef): string {
	if (page.isHomePage || page.slug === '' || page.slug === 'home') return '/'
	return `/${trimChar(page.slug, SLASH, 'start')}`
}

function trimSlash(path: string) {
	return trimChar(path, SLASH, 'both')
}

export function matchSitePage(
	href: string,
	pages: SitePageRef[],
): SitePageRef | undefined {
	const raw = href.trim()
	if (!raw || raw.startsWith('mailto:') || raw.startsWith('tel:')) {
		return undefined
	}

	let path = raw
	try {
		if (raw.startsWith('https://') || raw.startsWith('http://')) {
			path = new URL(raw).pathname
		}
	} catch {
		path = raw
	}

	const slug = trimSlash(path)
	if (SITE_LINK_RESERVED_PATHS.has(slug)) return undefined

	return pages.find((page) => {
		const pageSlug = trimSlash(page.slug)
		if (page.isHomePage || pageSlug === '' || pageSlug === 'home') {
			return slug === '' || slug === 'home'
		}
		return pageSlug === slug
	})
}

function parseMailto(href: string): { email: string; subject: string } {
	const withoutProtocol = href.slice('mailto:'.length)
	const [emailPart, query = ''] = withoutProtocol.split('?')
	const email = decodeURIComponent(emailPart ?? '').trim()
	const params = new URLSearchParams(query)
	const subject = params.get('subject') ?? ''
	return { email, subject }
}

function parseTel(href: string): string {
	return href.slice('tel:'.length).trim()
}

function looksLikeFileHref(href: string): boolean {
	return (
		href.includes('/resources/images?objectKey=') ||
		href.includes('/website/') ||
		/\.(pdf|svg|zip|docx?|xlsx?|pptx?|csv|json|txt)(?:$|[?#])/iu.test(href)
	)
}

function inferTypeFromHref(href: string, pages?: SitePageRef[]): SiteLinkType {
	const value = href.trim()
	if (value.toLowerCase().startsWith('mailto:')) return 'email'
	if (value.toLowerCase().startsWith('tel:')) return 'phone'
	if (looksLikeFileHref(value)) return 'file'
	if (pages && matchSitePage(value, pages)) return 'page'
	return 'url'
}

function fileNameFromHref(href: string): string {
	try {
		const url = new URL(href, 'https://example.local')
		const key = url.searchParams.get('objectKey')
		if (key) {
			const part = key.split('/').pop() ?? key
			return decodeURIComponent(part)
		}
		const last = url.pathname.split('/').pop()
		if (last) return decodeURIComponent(last)
	} catch {
		/* ignore */
	}
	return href.split('/').pop() || 'File'
}

export function computeSiteLinkHref(
	link: SiteLink,
	pages: SitePageRef[] = [],
): string {
	switch (link.type) {
		case 'email': {
			const email = link.email?.trim() ?? ''
			if (!email) return '#'
			const subject = link.subject?.trim() ?? ''
			return subject
				? `mailto:${email}?subject=${encodeURIComponent(subject)}`
				: `mailto:${email}`
		}
		case 'phone': {
			const phone = link.phone?.trim() ?? ''
			return phone ? `tel:${phone.replace(/\s+/gu, '')}` : '#'
		}
		case 'file': {
			return link.file?.url?.trim() || '#'
		}
		case 'page': {
			const page =
				pages.find((item) => item.id === link.pageId) ??
				pages.find((item) => item.slug === link.pageSlug)
			if (page) return getSitePageHref(page)
			if (link.pageSlug) {
				return getSitePageHref({
					id: link.pageId ?? '',
					slug: link.pageSlug,
				})
			}
			return '#'
		}
		case 'url':
		default: {
			const url = (link.url ?? link.href ?? '').trim()
			return url || '#'
		}
	}
}

function fromHref(href: string, pages?: SitePageRef[]): SiteLink {
	const trimmed = href.trim()
	const type = inferTypeFromHref(trimmed, pages)
	const link: SiteLink = {
		...DEFAULT_LINK,
		type,
		href: trimmed || '#',
	}

	if (type === 'email') {
		const parsed = parseMailto(trimmed)
		link.email = parsed.email
		link.subject = parsed.subject
		link.href = computeSiteLinkHref(link)
		return link
	}

	if (type === 'phone') {
		link.phone = parseTel(trimmed)
		link.href = computeSiteLinkHref(link)
		return link
	}

	if (type === 'file') {
		link.file = { url: trimmed, name: fileNameFromHref(trimmed) }
		link.href = trimmed || '#'
		return link
	}

	if (type === 'page') {
		const page = matchSitePage(trimmed, pages ?? [])
		link.pageId = page?.id
		link.pageSlug = page?.slug ?? trimSlash(trimmed)
		link.href = page ? getSitePageHref(page) : trimmed || '#'
		return link
	}

	link.url = trimmed === '#' ? '#' : trimmed
	link.href = trimmed || '#'
	return link
}

export function normalizeSiteLink(
	input: SiteLinkInput,
	pages: SitePageRef[] = [],
): SiteLink {
	if (input == null || input === '') {
		return { ...DEFAULT_LINK }
	}

	if (typeof input === 'string') {
		return fromHref(input, pages)
	}

	if (typeof input !== 'object') {
		return { ...DEFAULT_LINK }
	}

	const raw = input as SiteLink

	const type = isSiteLinkType(raw.type)
		? raw.type
		: inferTypeFromHref(
				(typeof raw.url === 'string' ? raw.url : '') ||
					(typeof raw.href === 'string' ? raw.href : ''),
				pages,
			)

	const link: SiteLink = {
		type,
		openIn: raw.openIn === 'blank' ? 'blank' : 'self',
		preload: isSiteLinkPreload(raw.preload) ? raw.preload : 'default',
		url: typeof raw.url === 'string' ? raw.url : undefined,
		href: typeof raw.href === 'string' ? raw.href : undefined,
		pageId: raw.pageId,
		pageSlug: raw.pageSlug,
		email: raw.email,
		subject: raw.subject,
		phone: raw.phone,
		file: raw.file,
	}

	if (type === 'url' && !link.url && link.href && link.href !== '#') {
		link.url = link.href
	}

	if (type === 'page' && !link.pageId && !link.pageSlug && link.href) {
		const page = matchSitePage(link.href, pages)
		if (page) {
			link.pageId = page.id
			link.pageSlug = page.slug
		}
	}

	link.href = computeSiteLinkHref(link, pages)
	return link
}

export function resolveSiteLink(
	input: SiteLinkInput,
	pages: SitePageRef[] = [],
): ResolvedSiteLink {
	const link = normalizeSiteLink(input, pages)
	const href = link.href || '#'
	const openInNewTab = link.openIn === 'blank'
	const relParts: string[] = []

	if (openInNewTab) relParts.push('noopener', 'noreferrer')

	if (
		(link.type === 'url' || link.type === 'page') &&
		(link.preload === 'prefetch' || link.preload === 'prerender')
	) {
		relParts.push(link.preload)
	}

	return {
		href,
		target: openInNewTab ? '_blank' : undefined,
		rel: relParts.length > 0 ? relParts.join(' ') : undefined,
	}
}

export function formatFileSize(bytes: number | undefined): string {
	if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return ''
	if (bytes < 1024) return `${Math.round(bytes)} B`
	const kb = bytes / 1024
	if (kb < 1024) {
		return `${kb < 10 ? kb.toFixed(1).replace(/\.0$/u, '') : Math.round(kb)} KB`
	}
	const mb = kb / 1024
	return `${mb < 10 ? mb.toFixed(1).replace(/\.0$/u, '') : Math.round(mb)} MB`
}

export function siteLinkHasDestination(input: SiteLinkInput): boolean {
	const href = resolveSiteLink(input).href
	return Boolean(href) && href !== '#'
}
