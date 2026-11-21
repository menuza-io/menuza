import dns from 'node:dns'
import { isIP } from 'node:net'
import { isPrivateIp, validateInstanceUrl } from '@repo/security/ssrf'
import {
	MENU_IMPORT_ALLOWED_URL_CONTENT_TYPES,
	MENU_IMPORT_FETCH_TIMEOUT_MS,
	MENU_IMPORT_MAX_BYTES,
	MENU_IMPORT_MAX_IMAGE_SUGGESTIONS,
	MENU_IMPORT_MAX_REDIRECTS,
	type MenuImportImageSuggestion,
} from './schema.ts'

export type DnsResolver = (hostname: string) => Promise<string[]>
export type MenuImportFetch = typeof fetch

export type FetchSourceDeps = {
	fetch?: MenuImportFetch
	resolve?: DnsResolver
	timeoutMs?: number
	maxBytes?: number
	maxRedirects?: number
}

export type UrlValidationResult =
	| { ok: true; url: string }
	| { ok: false; error: 'url_not_allowed' | 'fetch_failed'; reason: string }

export type FetchedMenuSource =
	| {
			ok: true
			kind: 'html'
			finalUrl: string
			contentType: string
			html: string
			byteLength: number
	  }
	| {
			ok: true
			kind: 'pdf'
			finalUrl: string
			contentType: string
			bytes: Uint8Array<ArrayBuffer>
			byteLength: number
	  }
	| {
			ok: false
			error: 'url_not_allowed' | 'fetch_failed' | 'unsupported_file'
			reason: string
	  }

export async function defaultResolveHost(hostname: string): Promise<string[]> {
	const [ipv4, ipv6] = await Promise.allSettled([
		dns.promises.resolve4(hostname),
		dns.promises.resolve6(hostname),
	])
	const ips: string[] = []
	if (ipv4.status === 'fulfilled') ips.push(...ipv4.value)
	if (ipv6.status === 'fulfilled') ips.push(...ipv6.value)
	if (ips.length > 0) return ips

	try {
		const records = await dns.promises.lookup(hostname, { all: true })
		return records.map((record) => record.address)
	} catch {
		return []
	}
}

export async function validateMenuImportUrl(
	rawUrl: string,
	resolve: DnsResolver = defaultResolveHost,
): Promise<UrlValidationResult> {
	const trimmed = rawUrl.trim()
	const textual = validateInstanceUrl(trimmed)
	if (!textual.valid) {
		return {
			ok: false,
			error: 'url_not_allowed',
			reason: textual.reason || 'URL is not allowed',
		}
	}

	let parsed: URL
	try {
		parsed = new URL(trimmed)
	} catch {
		return {
			ok: false,
			error: 'url_not_allowed',
			reason: 'Invalid URL format',
		}
	}

	if (parsed.protocol !== 'https:') {
		return {
			ok: false,
			error: 'url_not_allowed',
			reason: 'HTTPS is required',
		}
	}

	const bareHost = parsed.hostname
		.toLowerCase()
		.replace(/^\[|\]$/g, '')
		.replace(/\.$/, '')

	if (
		!bareHost ||
		bareHost === 'localhost' ||
		bareHost.endsWith('.localhost') ||
		bareHost.endsWith('.local') ||
		bareHost.endsWith('.internal') ||
		bareHost.endsWith('.localdomain')
	) {
		return {
			ok: false,
			error: 'url_not_allowed',
			reason: 'Forbidden internal hostname',
		}
	}

	if (isIP(bareHost) !== 0) {
		if (isPrivateIp(bareHost)) {
			return {
				ok: false,
				error: 'url_not_allowed',
				reason: `Private/internal IP address blocked: ${bareHost}`,
			}
		}
		return { ok: true, url: parsed.toString() }
	}

	let resolvedIps: string[]
	try {
		resolvedIps = await resolve(bareHost)
	} catch {
		return {
			ok: false,
			error: 'fetch_failed',
			reason: 'DNS resolution failed',
		}
	}

	if (resolvedIps.length === 0) {
		return {
			ok: false,
			error: 'fetch_failed',
			reason: 'DNS resolution returned no addresses',
		}
	}

	for (const ip of resolvedIps) {
		if (isPrivateIp(ip)) {
			return {
				ok: false,
				error: 'url_not_allowed',
				reason: `DNS resolved to private/internal IP: ${ip}`,
			}
		}
	}

	return { ok: true, url: parsed.toString() }
}

function normalizeContentType(header: string | null): string {
	if (!header) return ''
	return header.split(';')[0]?.trim().toLowerCase() ?? ''
}

function isRedirectStatus(status: number): boolean {
	return (
		status === 301 ||
		status === 302 ||
		status === 303 ||
		status === 307 ||
		status === 308
	)
}

async function readResponseWithCap(
	response: Response,
	maxBytes: number,
): Promise<{ ok: true; bytes: Uint8Array<ArrayBuffer> } | { ok: false }> {
	const contentLengthHeader = response.headers.get('content-length')
	if (contentLengthHeader) {
		const declared = Number(contentLengthHeader)
		if (Number.isFinite(declared) && declared > maxBytes) {
			await response.body?.cancel().catch(() => {})
			return { ok: false }
		}
	}

	if (!response.body) {
		const buffer = await response.arrayBuffer()
		if (buffer.byteLength > maxBytes) return { ok: false }
		return { ok: true, bytes: new Uint8Array(buffer) }
	}

	const reader = response.body.getReader()
	const chunks: Uint8Array[] = []
	let total = 0
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			if (!value) continue
			total += value.byteLength
			if (total > maxBytes) {
				await reader.cancel().catch(() => {})
				return { ok: false }
			}
			chunks.push(value)
		}
	} finally {
		reader.releaseLock()
	}

	const combined = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		combined.set(chunk, offset)
		offset += chunk.byteLength
	}
	return { ok: true, bytes: combined }
}

/**
 * Fetches a menu URL under strict SSRF, redirect, content-type, size, and
 * timeout guards:
 * - HTTPS only, public IPs only after DNS resolution (re-checked per hop)
 * - Up to 5 redirects
 * - 20s total timeout, 10 MB body cap
 * - Only HTML (`text/html`, `application/xhtml+xml`) and PDF (`application/pdf`)
 */
export async function fetchMenuSource(
	rawUrl: string,
	deps: FetchSourceDeps = {},
): Promise<FetchedMenuSource> {
	const fetchFn = deps.fetch ?? fetch
	const resolve = deps.resolve ?? defaultResolveHost
	const timeoutMs = deps.timeoutMs ?? MENU_IMPORT_FETCH_TIMEOUT_MS
	const maxBytes = deps.maxBytes ?? MENU_IMPORT_MAX_BYTES
	const maxRedirects = deps.maxRedirects ?? MENU_IMPORT_MAX_REDIRECTS

	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), timeoutMs)

	try {
		let currentUrl = rawUrl.trim()
		for (let hop = 0; hop <= maxRedirects; hop += 1) {
			const validation = await validateMenuImportUrl(currentUrl, resolve)
			if (!validation.ok) {
				return {
					ok: false,
					error: validation.error,
					reason: validation.reason,
				}
			}

			let response: Response
			try {
				response = await fetchFn(validation.url, {
					method: 'GET',
					redirect: 'manual',
					signal: controller.signal,
					headers: {
						Accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9',
					},
				})
			} catch (err) {
				return {
					ok: false,
					error: 'fetch_failed',
					reason: err instanceof Error ? err.message : 'Fetch failed',
				}
			}

			if (isRedirectStatus(response.status)) {
				await response.body?.cancel().catch(() => {})
				const location = response.headers.get('location')
				if (!location) {
					return {
						ok: false,
						error: 'fetch_failed',
						reason: 'Redirect response missing Location header',
					}
				}
				if (hop >= maxRedirects) {
					return {
						ok: false,
						error: 'fetch_failed',
						reason: 'Too many redirects',
					}
				}
				try {
					currentUrl = new URL(location, validation.url).toString()
				} catch {
					return {
						ok: false,
						error: 'url_not_allowed',
						reason: 'Invalid redirect URL',
					}
				}
				continue
			}

			if (!response.ok) {
				await response.body?.cancel().catch(() => {})
				return {
					ok: false,
					error: 'fetch_failed',
					reason: `HTTP ${response.status}`,
				}
			}

			const contentType = normalizeContentType(
				response.headers.get('content-type'),
			)
			if (
				!(MENU_IMPORT_ALLOWED_URL_CONTENT_TYPES as readonly string[]).includes(
					contentType,
				)
			) {
				await response.body?.cancel().catch(() => {})
				return {
					ok: false,
					error: 'unsupported_file',
					reason: `Unsupported content type: ${contentType || 'unknown'}`,
				}
			}

			let bodyResult:
				{ ok: true; bytes: Uint8Array<ArrayBuffer> } | { ok: false }
			try {
				bodyResult = await readResponseWithCap(response, maxBytes)
			} catch (err) {
				return {
					ok: false,
					error: 'fetch_failed',
					reason: err instanceof Error ? err.message : 'Body read failed',
				}
			}

			if (!bodyResult.ok) {
				return {
					ok: false,
					error: 'fetch_failed',
					reason: 'Response exceeded maximum allowed size',
				}
			}

			if (contentType === 'application/pdf') {
				return {
					ok: true,
					kind: 'pdf',
					finalUrl: validation.url,
					contentType,
					bytes: bodyResult.bytes,
					byteLength: bodyResult.bytes.byteLength,
				}
			}

			const html = new TextDecoder('utf-8', { fatal: false }).decode(
				bodyResult.bytes,
			)
			return {
				ok: true,
				kind: 'html',
				finalUrl: validation.url,
				contentType,
				html,
				byteLength: bodyResult.bytes.byteLength,
			}
		}

		return {
			ok: false,
			error: 'fetch_failed',
			reason: 'Too many redirects',
		}
	} finally {
		clearTimeout(timer)
	}
}

const HTML_ENTITY_MAP: Record<string, string> = {
	'&amp;': '&',
	'&lt;': '<',
	'&gt;': '>',
	'&quot;': '"',
	'&#39;': "'",
	'&apos;': "'",
	'&nbsp;': ' ',
}

function decodeHtmlEntities(input: string): string {
	return input
		.replace(
			/&(amp|lt|gt|quot|#39|apos|nbsp);/gi,
			(match) => HTML_ENTITY_MAP[match.toLowerCase()] ?? match,
		)
		.replace(/&#(\d+);/g, (_match, dec: string) => {
			const code = Number(dec)
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff
				? String.fromCodePoint(code)
				: ''
		})
		.replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => {
			const code = Number.parseInt(hex, 16)
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff
				? String.fromCodePoint(code)
				: ''
		})
}

function getHtmlAttr(tag: string, attrName: string): string | null {
	const doubleQuoted = new RegExp(`\\b${attrName}\\s*=\\s*"([^"]*)"`, 'i')
	const singleQuoted = new RegExp(`\\b${attrName}\\s*=\\s*'([^']*)'`, 'i')
	const unquoted = new RegExp(`\\b${attrName}\\s*=\\s*([^\\s>]+)`, 'i')
	const match =
		tag.match(doubleQuoted) ?? tag.match(singleQuoted) ?? tag.match(unquoted)
	return match?.[1] ? decodeHtmlEntities(match[1].trim()) : null
}

/**
 * Extracts readable visible text and public HTTPS image suggestions from an
 * HTML menu page. Images are suggestions only and are never auto-attached.
 */
export function extractHtmlMenuTextAndImages(
	html: string,
	pageUrl: string,
): {
	title: string | null
	text: string
	imageSuggestions: MenuImportImageSuggestion[]
} {
	const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
	const title = titleMatch?.[1]
		? decodeHtmlEntities(titleMatch[1])
				.replace(/\s+/g, ' ')
				.trim()
				.slice(0, 120) || null
		: null

	const imageSuggestions: MenuImportImageSuggestion[] = []
	const seenImageUrls = new Set<string>()
	const addImageCandidate = (rawSrc: string | null, alt: string | null) => {
		if (
			!rawSrc ||
			imageSuggestions.length >= MENU_IMPORT_MAX_IMAGE_SUGGESTIONS
		) {
			return
		}
		if (/^(data|blob|javascript):/i.test(rawSrc.trim())) return
		let resolved: string
		try {
			resolved = new URL(rawSrc.trim(), pageUrl).toString()
		} catch {
			return
		}
		if (!validateInstanceUrl(resolved).valid) return
		if (seenImageUrls.has(resolved)) return
		seenImageUrls.add(resolved)
		const cleanedAlt = alt ? alt.replace(/\s+/g, ' ').trim().slice(0, 200) : ''
		imageSuggestions.push({
			url: resolved,
			alt: cleanedAlt || null,
		})
	}

	const metaRegex = /<meta\b[^>]*>/gi
	for (const match of html.matchAll(metaRegex)) {
		const tag = match[0]
		const prop = getHtmlAttr(tag, 'property') ?? getHtmlAttr(tag, 'name')
		if (prop && prop.toLowerCase() === 'og:image') {
			addImageCandidate(getHtmlAttr(tag, 'content'), title)
		}
	}

	const imgRegex = /<img\b[^>]*>/gi
	for (const match of html.matchAll(imgRegex)) {
		const tag = match[0]
		const src = getHtmlAttr(tag, 'src') ?? getHtmlAttr(tag, 'data-src')
		const alt = getHtmlAttr(tag, 'alt')
		addImageCandidate(src, alt)
	}

	const stripped = html
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ')
		.replace(
			/<\/?(p|div|section|article|header|footer|li|tr|td|th|h[1-6]|br|hr)\b[^>]*>/gi,
			'\n',
		)
		.replace(/<[^>]+>/g, ' ')

	const text = decodeHtmlEntities(stripped)
		.split('\n')
		.map((line) => line.replace(/[ \t]+/g, ' ').trim())
		.filter(Boolean)
		.join('\n')
		.slice(0, 120_000)

	return {
		title,
		text,
		imageSuggestions,
	}
}
