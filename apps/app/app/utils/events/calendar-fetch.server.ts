import {
	defaultResolveHost,
	validateMenuImportUrl,
	type DnsResolver,
} from '#app/utils/menu/import/fetch-source.server.ts'
import { ICAL_MAX_BYTES } from './ical.ts'

/**
 * Fetches a calendar feed for the website's events (#319), read-only, under
 * the same guards as the menu importer: https only, public hosts only (DNS is
 * checked before every hop, and again before the body is read), redirects are
 * followed by hand and each hop is re-checked, a size cap, a time limit and a
 * content check. The address (which may be a secret one) is never logged and
 * never part of an error.
 */

export type CalendarFetchError =
	'url_not_allowed' | 'fetch_failed' | 'invalid_calendar' | 'too_large'

export type CalendarFetchResult =
	{ ok: true; text: string } | { ok: false; error: CalendarFetchError }

export type CalendarFetchDeps = {
	fetch?: typeof fetch
	resolve?: DnsResolver
	timeoutMs?: number
	maxRedirects?: number
}

const ALLOWED_TYPES = new Set([
	'text/calendar',
	'text/plain',
	'application/octet-stream',
	'application/ics',
])

function isRedirect(status: number) {
	return [301, 302, 303, 307, 308].includes(status)
}

export async function fetchCalendarFeed(
	rawUrl: string,
	deps: CalendarFetchDeps = {},
): Promise<CalendarFetchResult> {
	const fetchFn = deps.fetch ?? fetch
	const resolve = deps.resolve ?? defaultResolveHost
	const maxRedirects = deps.maxRedirects ?? 3
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 15_000)
	try {
		let current = rawUrl
		for (let hop = 0; hop <= maxRedirects; hop++) {
			const checked = await validateMenuImportUrl(current, resolve)
			if (!checked.ok) {
				return {
					ok: false,
					error:
						checked.error === 'url_not_allowed'
							? 'url_not_allowed'
							: 'fetch_failed',
				}
			}
			let response: Response
			try {
				response = await fetchFn(checked.url, {
					method: 'GET',
					redirect: 'manual',
					signal: controller.signal,
					headers: { Accept: 'text/calendar, text/plain;q=0.8' },
				})
			} catch {
				return { ok: false, error: 'fetch_failed' }
			}
			if (isRedirect(response.status)) {
				await response.body?.cancel().catch(() => {})
				const location = response.headers.get('location')
				if (!location || hop >= maxRedirects) {
					return { ok: false, error: 'fetch_failed' }
				}
				try {
					current = new URL(location, checked.url).toString()
				} catch {
					return { ok: false, error: 'url_not_allowed' }
				}
				continue
			}
			if (!response.ok) {
				await response.body?.cancel().catch(() => {})
				return { ok: false, error: 'fetch_failed' }
			}
			// Narrow the DNS rebinding window before reading anything.
			const again = await validateMenuImportUrl(checked.url, resolve)
			if (!again.ok) {
				await response.body?.cancel().catch(() => {})
				return { ok: false, error: 'url_not_allowed' }
			}
			const type = (response.headers.get('content-type') ?? '')
				.split(';')[0]!
				.trim()
				.toLowerCase()
			if (type && !ALLOWED_TYPES.has(type)) {
				await response.body?.cancel().catch(() => {})
				return { ok: false, error: 'invalid_calendar' }
			}
			const declared = Number(response.headers.get('content-length'))
			if (Number.isFinite(declared) && declared > ICAL_MAX_BYTES) {
				await response.body?.cancel().catch(() => {})
				return { ok: false, error: 'too_large' }
			}
			const body = await readCapped(response, ICAL_MAX_BYTES)
			if (!body) return { ok: false, error: 'too_large' }
			const text = new TextDecoder('utf-8', { fatal: false }).decode(body)
			if (!/^﻿?\s*BEGIN:VCALENDAR/iu.test(text)) {
				return { ok: false, error: 'invalid_calendar' }
			}
			return { ok: true, text }
		}
		return { ok: false, error: 'fetch_failed' }
	} finally {
		clearTimeout(timer)
	}
}

async function readCapped(response: Response, max: number) {
	if (!response.body) {
		const buffer = new Uint8Array(await response.arrayBuffer())
		return buffer.byteLength > max ? null : buffer
	}
	const reader = response.body.getReader()
	const chunks: Uint8Array[] = []
	let total = 0
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			if (!value) continue
			total += value.byteLength
			if (total > max) {
				await reader.cancel().catch(() => {})
				return null
			}
			chunks.push(value)
		}
	} finally {
		reader.releaseLock()
	}
	const out = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		out.set(chunk, offset)
		offset += chunk.byteLength
	}
	return out
}
