/**
 * Import an existing restaurant site and export a backup (#140).
 * Fetching is injected: tests pass fixture HTML and never call a live host.
 * Redirect suggestions go through the existing destination and cycle checks.
 */
import { BLOCK_TYPES, type BlockType } from './block-types.ts'
import {
	checkRedirectDestination,
	type RedirectDestinationCheck,
} from './redirect-destination.ts'
import {
	hasRedirectCycle,
	normalizeRedirectPath,
	type RedirectRow,
} from './redirect-plan.ts'

export const IMPORT_PAGE_CAP = 50
export const IMPORT_IMAGE_CAP = 300
export const IMPORT_MAX_REDIRECTS = 5
export const IMPORT_IMAGE_BYTES = 10 * 1024 * 1024

const ORDERING_WIDGET =
	/(doordash|ubereats|grubhub|toasttab|chownow|square\.site|olo\.com)/i

const IMAGE_TAG = new RegExp('<' + 'img\\b[^>]*>', 'gi')
const PAGE_LINK = new RegExp('<' + 'a\\b[^>]*href=["\']([^"\']+)["\']', 'gi')

export type ImportFetchTarget =
	| { ok: true; url: URL }
	| { ok: false; reason: 'blocked' | 'off_site' | 'bad_url' }

export function isPrivateOrInternalIp(ip: string): boolean {
	const value = ip
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, '')
	if (!value) return true
	if (value === '::1' || value === '0.0.0.0') return true
	if (
		value.startsWith('fc') ||
		value.startsWith('fd') ||
		value.startsWith('fe80:')
	) {
		return true
	}
	const mapped = value.startsWith('::ffff:') ? value.slice(7) : value
	const parts = mapped.split('.').map((part) => Number(part))
	if (
		parts.length !== 4 ||
		parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
	) {
		return value.includes(':')
	}
	const a = parts[0] ?? 0
	const b = parts[1] ?? 0
	if (a === 10 || a === 127 || a === 0) return true
	if (a === 169 && b === 254) return true
	if (a === 192 && b === 168) return true
	if (a === 172 && b >= 16 && b <= 31) return true
	if (a === 100 && b >= 64 && b <= 127) return true
	return false
}

function hostBlocked(hostname: string) {
	const host = hostname.toLowerCase().replace(/\.$/, '')
	if (
		host === 'localhost' ||
		host.endsWith('.localhost') ||
		host.endsWith('.local') ||
		host.endsWith('.internal') ||
		host === 'metadata.google.internal'
	) {
		return true
	}
	return isPrivateOrInternalIp(host)
}

export function sameSiteHost(startHost: string, nextHost: string) {
	const bare = (host: string) =>
		host
			.toLowerCase()
			.replace(/\.$/, '')
			.replace(/^www\./, '')
	return bare(startHost) === bare(nextHost)
}

/**
 * Refuses private and internal addresses, credentials, and anything that is
 * not http(s) on the same site (apex or www). `resolve` is DNS; tests pass
 * a map. Redirect hops are counted by the caller.
 */
export async function checkImportTarget(
	raw: string,
	options: {
		startHost: string
		resolve: (hostname: string) => Promise<string[]>
		redirectsFollowed?: number
	},
): Promise<ImportFetchTarget> {
	if ((options.redirectsFollowed ?? 0) > IMPORT_MAX_REDIRECTS) {
		return { ok: false, reason: 'blocked' }
	}
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		return { ok: false, reason: 'bad_url' }
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return { ok: false, reason: 'bad_url' }
	}
	if (url.username || url.password) return { ok: false, reason: 'blocked' }
	if (!sameSiteHost(options.startHost, url.hostname)) {
		return { ok: false, reason: 'off_site' }
	}
	if (hostBlocked(url.hostname)) return { ok: false, reason: 'blocked' }
	const addresses = await options.resolve(url.hostname)
	if (
		addresses.length === 0 ||
		addresses.some((ip) => isPrivateOrInternalIp(ip))
	) {
		return { ok: false, reason: 'blocked' }
	}
	return { ok: true, url }
}

export type ExtractedImage = { src: string; alt: string }

export type ExtractedPage = {
	url: string
	title: string
	headings: string[]
	paragraphs: string[]
	images: ExtractedImage[]
	skipReason: string | null
}

function textOf(html: string, tag: string) {
	const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(html)
	return match ? decode(match[1]!.replace(/<[^>]+>/g, ' ')) : ''
}

function decode(value: string) {
	return value
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\s+/g, ' ')
		.trim()
}

export function extractReadablePage(url: string, html: string): ExtractedPage {
	const title = textOf(html, 'title') || textOf(html, 'h1') || 'Page'
	const headings = [
		...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi),
	].map((match) => decode(match[1]!.replace(/<[^>]+>/g, ' ')))
	const paragraphs = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
		.map((match) => decode(match[1]!.replace(/<[^>]+>/g, ' ')))
		.filter((text) => text.length > 1)
	const images = [...html.matchAll(IMAGE_TAG)]
		.map((match) => {
			const tag = match[0]
			const src = /src=["']([^"']+)["']/i.exec(tag)?.[1] ?? ''
			const alt = /alt=["']([^"']*)["']/i.exec(tag)?.[1] ?? ''
			return { src, alt: decode(alt) }
		})
		.filter((image) => image.src)
	let skipReason: string | null = null
	if (/<input[^>]+type=["']password["']/i.test(html)) {
		skipReason = 'login'
	} else if (ORDERING_WIDGET.test(html)) {
		skipReason = 'ordering_widget'
	} else {
		const action = /<form\b[^>]*action=["']([^"']+)["']/i.exec(html)?.[1]
		if (action && /^https?:/i.test(action)) {
			try {
				const page = new URL(url)
				const target = new URL(action, url)
				if (!sameSiteHost(page.hostname, target.hostname)) {
					skipReason = 'foreign_form'
				}
			} catch {
				skipReason = 'foreign_form'
			}
		}
	}
	return { url, title, headings, paragraphs, images, skipReason }
}

export type RobotsRule = { allow: string[]; disallow: string[] }

export function parseRobots(text: string): RobotsRule {
	const allow: string[] = []
	const disallow: string[] = []
	let applies = false
	for (const line of text.split('\n')) {
		const trimmed = line.trim()
		const agent = /^user-agent:\s*(.+)$/i.exec(trimmed)
		if (agent) {
			applies = agent[1]!.trim() === '*'
			continue
		}
		if (!applies) continue
		const disallowMatch = /^disallow:\s*(.*)$/i.exec(trimmed)
		if (disallowMatch) {
			const path = disallowMatch[1]!.trim()
			if (path) disallow.push(path)
			continue
		}
		const allowMatch = /^allow:\s*(.*)$/i.exec(trimmed)
		if (allowMatch && allowMatch[1]!.trim()) allow.push(allowMatch[1]!.trim())
	}
	return { allow, disallow }
}

export function robotsAllows(pathname: string, robots: RobotsRule) {
	const path = pathname.startsWith('/') ? pathname : `/${pathname}`
	const blocked = robots.disallow.some((rule) => path.startsWith(rule))
	if (!blocked) return true
	return robots.allow.some((rule) => path.startsWith(rule) && rule.length >= 1)
}

export type ProposedSection = {
	type: BlockType
	config: Record<string, unknown>
}

export function proposeSections(page: ExtractedPage): ProposedSection[] {
	if (page.skipReason) return []
	const sections: ProposedSection[] = []
	const heading = page.headings[0] || page.title
	const image = page.images[0]
	if (heading) {
		sections.push({
			type: 'hero',
			config: {
				heading,
				subheading: page.paragraphs[0] ?? '',
				links: [],
				assetType: image ? 'image' : 'none',
				imageUrl: image?.src ?? '',
				slides: page.images.slice(0, 6).map((item) => ({
					url: item.src,
					alt: item.alt,
				})),
				overlay: image ? 'dark' : 'none',
				textPosition: 'left',
				minHeight: 480,
			},
		})
	}
	const body = page.paragraphs.slice(image ? 1 : 0).join('\n\n')
	if (body) {
		sections.push({
			type: 'content',
			config: {
				title: page.headings[1] ?? '',
				subtitle: '',
				body,
				layout: 'text',
				background: 'none',
				ctaLabel: '',
				ctaUrl: '',
			},
		})
	}
	if (page.images.length > 1) {
		sections.push({
			type: 'gallery',
			config: {
				title: '',
				subtitle: '',
				columns: 3,
				images: page.images.slice(0, 12).map((item) => ({
					url: item.src,
					alt: item.alt,
					caption: '',
					type: 'image',
				})),
			},
		})
	}
	const questions = page.headings.filter((item) => item.endsWith('?'))
	if (questions.length > 0) {
		sections.push({
			type: 'faq',
			config: {
				title: 'Questions',
				items: questions.map((question) => ({ question, answer: '' })),
			},
		})
	}
	const contactish = /contact|visit|hour/i.test(
		`${page.title} ${page.headings.join(' ')}`,
	)
	if (contactish) {
		sections.push({
			type: 'contact',
			config: {
				heading: 'Contact',
				intro: page.paragraphs[0] ?? '',
				email: '',
				showForm: false,
				formId: '',
			},
		})
		sections.push({
			type: 'locationsHours',
			config: { heading: 'Visit us', subtitle: '', locationIds: [] },
		})
	}
	return sections.filter((section) =>
		Object.prototype.hasOwnProperty.call(BLOCK_TYPES, section.type),
	)
}

/**
 * Reads a site from an injected fetcher. Tests pass fixture HTML. The fetcher
 * is responsible for refusing private addresses before any request leaves.
 */
export async function crawlSite(options: {
	startUrl: string
	fetchPage: (url: string) => Promise<string | null>
	robotsText?: string
}): Promise<ExtractedPage[]> {
	const start = new URL(options.startUrl)
	const robots = parseRobots(options.robotsText ?? '')
	const queue = [start.toString()]
	const seen = new Set<string>()
	const pages: ExtractedPage[] = []
	while (queue.length > 0 && pages.length < IMPORT_PAGE_CAP) {
		const current = queue.shift()
		if (!current || seen.has(current)) continue
		seen.add(current)
		let pathname = '/'
		try {
			pathname = new URL(current).pathname
		} catch {
			continue
		}
		if (!robotsAllows(pathname, robots)) continue
		const html = await options.fetchPage(current)
		if (!html) continue
		const page = extractReadablePage(current, html)
		pages.push(page)
		if (page.skipReason) continue
		for (const match of html.matchAll(PAGE_LINK)) {
			const href = match[1]
			if (!href || href.startsWith('#') || href.startsWith('mailto:')) continue
			try {
				const next = new URL(href, current)
				if (!sameSiteHost(start.hostname, next.hostname)) continue
				next.hash = ''
				const normalized = next.toString()
				if (!seen.has(normalized)) queue.push(normalized)
			} catch {
				// Ignore a link that is not a URL.
			}
		}
	}
	return pages
}

export function suggestPageSlug(url: string) {
	let pathname = '/'
	try {
		pathname = new URL(url).pathname
	} catch {
		pathname = url
	}
	const base = pathname
		.replace(/\.(html|php|aspx)$/i, '')
		.replace(/\/+$/, '')
		.split('/')
		.filter(Boolean)
		.pop()
	if (!base || base === 'index') return 'home'
	return (
		base
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '')
			.slice(0, 80) || 'page'
	)
}

const SLUG_HINTS: Array<[RegExp, string]> = [
	[/^menu/, 'menu'],
	[/contact/, 'contact'],
	[/about/, 'about'],
	[/hour/, 'hours'],
	[/reserv/, 'reserve'],
]

export function suggestedDestination(
	url: string,
	createdSlugs: ReadonlySet<string>,
) {
	const slug = suggestPageSlug(url)
	for (const [pattern, hint] of SLUG_HINTS) {
		if (!pattern.test(slug)) continue
		if (hint === 'menu') return '/menu'
		if (hint === 'reserve') return '/reserve'
		if (createdSlugs.has(hint)) return `/${hint}`
	}
	if (slug === 'home') return '/'
	if (createdSlugs.has(slug)) return `/${slug}`
	return `/${slug}`
}

export type RedirectSuggestion = {
	fromPath: string
	toPath: string
	statusCode: 301
	ok: boolean
	reason?: string
}

export function planImportRedirects(input: {
	pages: Array<{ url: string; slug: string; skipped: boolean }>
	existing: readonly RedirectRow[]
	siteHosts?: readonly string[]
}): RedirectSuggestion[] {
	const created = new Set(
		input.pages.filter((page) => !page.skipped).map((page) => page.slug),
	)
	const planned: RedirectRow[] = [...input.existing]
	const suggestions: RedirectSuggestion[] = []
	for (const page of input.pages) {
		let fromPath = '/'
		try {
			fromPath = normalizeRedirectPath(new URL(page.url).pathname)
		} catch {
			fromPath = normalizeRedirectPath(page.url)
		}
		const toPath = page.skipped ? '/' : suggestedDestination(page.url, created)
		const destination: RedirectDestinationCheck = checkRedirectDestination(
			toPath,
			{ siteHosts: input.siteHosts },
		)
		if (!destination.ok) {
			suggestions.push({
				fromPath,
				toPath,
				statusCode: 301,
				ok: false,
				reason: destination.code,
			})
			continue
		}
		if (
			planned.some(
				(row) => row.fromPath.toLowerCase() === fromPath.toLowerCase(),
			)
		) {
			suggestions.push({
				fromPath,
				toPath: destination.value,
				statusCode: 301,
				ok: false,
				reason: 'redirect_exists',
			})
			continue
		}
		if (hasRedirectCycle(planned, fromPath, destination.value)) {
			suggestions.push({
				fromPath,
				toPath: destination.value,
				statusCode: 301,
				ok: false,
				reason: 'redirect_loop',
			})
			continue
		}
		planned.push({
			id: `import-${fromPath}`,
			fromPath,
			toPath: destination.value,
		})
		suggestions.push({
			fromPath,
			toPath: destination.value,
			statusCode: 301,
			ok: true,
		})
	}
	return suggestions
}

export type SiteBackup = {
	version: 1
	pages: Array<{
		title: string
		slug: string
		isHomePage: boolean
		sections: Array<{ type: string; config: Record<string, unknown> }>
	}>
	theme: unknown
	header: unknown
	footer: unknown
	redirects: Array<{ fromPath: string; toPath: string; statusCode: number }>
	forms: Array<{ id: string; name: string; fields: unknown }>
	media: Array<{ path: string; contentType: string }>
}

const BACKUP_KEYS = [
	'version',
	'pages',
	'theme',
	'header',
	'footer',
	'redirects',
	'forms',
	'media',
] as const

/** Pages, theme, chrome, redirects, form definitions and media. Nothing else. */
export function buildSiteBackup(input: {
	pages: SiteBackup['pages']
	theme: unknown
	header: unknown
	footer: unknown
	redirects: SiteBackup['redirects']
	forms: SiteBackup['forms']
	media: SiteBackup['media']
}): SiteBackup {
	return {
		version: 1,
		pages: input.pages,
		theme: input.theme,
		header: input.header,
		footer: input.footer,
		redirects: input.redirects,
		forms: input.forms.map((form) => ({
			id: form.id,
			name: form.name,
			fields: form.fields,
		})),
		media: input.media,
	}
}

export function backupHasForbiddenData(backup: SiteBackup) {
	const json = JSON.stringify(backup)
	const extra = Object.keys(backup).filter(
		(key) => !(BACKUP_KEYS as readonly string[]).includes(key),
	)
	if (extra.length > 0) return true
	return /submission|password|secret/i.test(json)
}

export type RestoredPage = {
	title: string
	slug: string
	status: 'draft'
	sections: Array<{ type: BlockType; config: Record<string, unknown> }>
}

/** Recreates pages as drafts. Unknown section types are dropped. */
export function pagesFromBackup(backup: SiteBackup): RestoredPage[] {
	if (backup.version !== 1 || !Array.isArray(backup.pages)) return []
	return backup.pages.map((page) => ({
		title: page.title,
		slug: page.slug,
		status: 'draft' as const,
		sections: (page.sections ?? []).flatMap((section) => {
			if (!Object.prototype.hasOwnProperty.call(BLOCK_TYPES, section.type)) {
				return []
			}
			if (!section.config || typeof section.config !== 'object') return []
			return [
				{
					type: section.type as BlockType,
					config: section.config,
				},
			]
		}),
	}))
}

export function capImportPages<T>(pages: readonly T[]) {
	return pages.slice(0, IMPORT_PAGE_CAP)
}
