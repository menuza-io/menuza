import crypto from 'node:crypto'
import { PRINT_ARTWORK_MAX_BYTES } from '@repo/common/print-shop'
import { canvaEnv, canvaRedirectUri, isCanvaMock } from './env.server.ts'
import { CanvaError } from './errors.ts'
import { mockCanva } from './mock.server.ts'

export { CanvaError, type CanvaErrorCode } from './errors.ts'

/**
 * Canva Connect API client. Every call acts for one Canva user (OAuth with
 * PKCE; tokens from `connection.server.ts`). Token requests go from the App
 * server only, never the browser. Under `CANVA_MOCK` (local only) the same
 * functions answer from `mock.server.ts` without network access.
 */

const API = 'https://api.canva.com/rest/v1'
const AUTHORIZE_URL = 'https://www.canva.com/api/oauth/authorize'

/** What the Print shop asks a Canva user to allow. */
export const CANVA_SCOPES = [
	'design:meta:read',
	'design:content:read',
	'design:content:write',
	'profile:read',
] as const

export type CanvaTokens = {
	accessToken: string
	refreshToken: string
	expiresAt: Date
	scope: string
}

export type CanvaDesign = {
	id: string
	title: string
	pageCount: number | null
	thumbnail: { url: string; width: number; height: number } | null
	editUrl: string | null
}

export type CanvaExportFormat =
	{ type: 'pdf'; quality: 'regular' | 'pro' } | { type: 'png'; width: number }

// ---------------------------------------------------------------------------
// PKCE and OAuth
// ---------------------------------------------------------------------------

export function createPkce(): { verifier: string; challenge: string } {
	const verifier = crypto.randomBytes(48).toString('base64url')
	const challenge = crypto
		.createHash('sha256')
		.update(verifier)
		.digest('base64url')
	return { verifier, challenge }
}

export function canvaAuthorizeUrl(input: {
	state: string
	challenge: string
}): string {
	const url = new URL(AUTHORIZE_URL)
	url.searchParams.set('code_challenge', input.challenge)
	url.searchParams.set('code_challenge_method', 'S256')
	url.searchParams.set('scope', CANVA_SCOPES.join(' '))
	url.searchParams.set('response_type', 'code')
	url.searchParams.set('client_id', canvaEnv('CANVA_CLIENT_ID'))
	url.searchParams.set('state', input.state)
	url.searchParams.set('redirect_uri', canvaRedirectUri())
	return url.toString()
}

function basicAuth() {
	const id = canvaEnv('CANVA_CLIENT_ID')
	const secret = canvaEnv('CANVA_CLIENT_SECRET')
	if (!id || !secret) {
		throw new CanvaError('unavailable', 'Canva is not configured')
	}
	return `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`
}

async function tokenRequest(
	form: Record<string, string>,
): Promise<CanvaTokens> {
	let response: Response
	try {
		response = await fetch(`${API}/oauth/token`, {
			method: 'POST',
			headers: {
				Authorization: basicAuth(),
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams(form),
			redirect: 'error',
			signal: AbortSignal.timeout(15_000),
		})
	} catch {
		throw new CanvaError('unavailable', 'Canva did not answer')
	}
	const body = (await response.json().catch(() => null)) as Record<
		string,
		unknown
	> | null
	const reason = body?.error ?? body?.code
	if (
		(response.status === 400 || response.status === 401) &&
		reason === 'invalid_grant'
	) {
		// A used or revoked refresh token, or a bad code: connect again.
		throw new CanvaError(
			'invalid_grant',
			'Canva refused the grant',
			response.status,
		)
	}
	if (
		!response.ok ||
		typeof body?.access_token !== 'string' ||
		typeof body.refresh_token !== 'string'
	) {
		throw new CanvaError(
			'unavailable',
			`Canva token request failed (${response.status})`,
			response.status,
		)
	}
	const expiresIn = Number(body.expires_in)
	return {
		accessToken: body.access_token,
		refreshToken: body.refresh_token,
		expiresAt: new Date(
			Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000,
		),
		scope: typeof body.scope === 'string' ? body.scope : CANVA_SCOPES.join(' '),
	}
}

export async function exchangeCanvaCode(input: {
	code: string
	verifier: string
}): Promise<CanvaTokens> {
	if (isCanvaMock()) return mockCanva.tokens()
	return tokenRequest({
		grant_type: 'authorization_code',
		code: input.code,
		code_verifier: input.verifier,
		redirect_uri: canvaRedirectUri(),
	})
}

/** Refresh tokens are single use: the answer carries the next one. */
export async function refreshCanvaTokens(
	refreshToken: string,
): Promise<CanvaTokens> {
	if (isCanvaMock()) return mockCanva.tokens()
	return tokenRequest({
		grant_type: 'refresh_token',
		refresh_token: refreshToken,
	})
}

/** Best effort: a disconnect never fails because Canva did not answer. */
export async function revokeCanvaToken(token: string): Promise<void> {
	if (isCanvaMock()) return
	await fetch(`${API}/oauth/revoke`, {
		method: 'POST',
		headers: {
			Authorization: basicAuth(),
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: new URLSearchParams({ token }),
		redirect: 'error',
		signal: AbortSignal.timeout(10_000),
	}).catch(() => null)
}

// ---------------------------------------------------------------------------
// REST calls for one user
// ---------------------------------------------------------------------------

function errorFor(status: number, message: string) {
	if (status === 401) return new CanvaError('unauthorized', message, status)
	if (status === 403 || status === 404) {
		return new CanvaError('not_found', message, status)
	}
	if (status === 429) return new CanvaError('rate_limited', message, status)
	return new CanvaError('unavailable', message, status)
}

async function call(
	accessToken: string,
	path: string,
	init: RequestInit = {},
): Promise<Record<string, unknown>> {
	let response: Response
	try {
		response = await fetch(`${API}${path}`, {
			...init,
			headers: {
				Authorization: `Bearer ${accessToken}`,
				...(init.body && !(init.body instanceof Uint8Array)
					? { 'Content-Type': 'application/json' }
					: {}),
				...(init.headers as Record<string, string> | undefined),
			},
			redirect: 'error',
			signal: AbortSignal.timeout(30_000),
		})
	} catch {
		throw new CanvaError('unavailable', 'Canva did not answer')
	}
	const body = (await response.json().catch(() => null)) as Record<
		string,
		unknown
	> | null
	if (!response.ok) {
		throw errorFor(response.status, `Canva answered ${response.status}`)
	}
	if (!body) throw new CanvaError('unavailable', 'Canva sent no answer')
	return body
}

function toDesign(raw: unknown): CanvaDesign | null {
	const item = raw as Record<string, unknown> | null
	if (!item || typeof item.id !== 'string') return null
	const thumb = item.thumbnail as Record<string, unknown> | undefined
	const urls = item.urls as Record<string, unknown> | undefined
	return {
		id: item.id,
		title:
			typeof item.title === 'string' && item.title ? item.title : 'Untitled',
		pageCount: typeof item.page_count === 'number' ? item.page_count : null,
		thumbnail:
			thumb && typeof thumb.url === 'string'
				? {
						url: thumb.url,
						width: Number(thumb.width) || 0,
						height: Number(thumb.height) || 0,
					}
				: null,
		editUrl: typeof urls?.edit_url === 'string' ? urls.edit_url : null,
	}
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Polls an asynchronous job until it succeeds, fails or runs out of time. */
async function pollJob(
	accessToken: string,
	path: string,
	initial: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	let job = initial.job as Record<string, unknown> | undefined
	const deadline = Date.now() + 90_000
	let delay = 600
	while (job?.status === 'in_progress') {
		if (Date.now() > deadline) {
			throw new CanvaError('unavailable', 'Canva is taking too long')
		}
		await wait(delay)
		delay = Math.min(delay * 1.5, 4000)
		job = (await call(accessToken, `${path}/${String(job.id)}`)).job as
			Record<string, unknown> | undefined
	}
	if (job?.status === 'success') return job
	const error = job?.error as Record<string, unknown> | undefined
	if (error?.code === 'license_required') {
		throw new CanvaError('license_required', 'The design needs a Canva license')
	}
	throw new CanvaError(
		'failed',
		typeof error?.message === 'string' ? error.message : 'The Canva job failed',
	)
}

export function canvaApi(accessToken: string) {
	if (isCanvaMock()) return mockCanva.api()
	return {
		async profile(): Promise<{
			userId: string | null
			displayName: string | null
		}> {
			const me = await call(accessToken, '/users/me').catch(() => null)
			const profile = await call(accessToken, '/users/me/profile').catch(
				() => null,
			)
			const team = me?.team_user as Record<string, unknown> | undefined
			const details = profile?.profile as Record<string, unknown> | undefined
			return {
				userId: typeof team?.user_id === 'string' ? team.user_id : null,
				displayName:
					typeof details?.display_name === 'string'
						? details.display_name
						: null,
			}
		},

		async listDesigns(input: { query?: string; continuation?: string }) {
			const params = new URLSearchParams({
				limit: '24',
				sort_by: input.query ? 'relevance' : 'modified_descending',
			})
			if (input.query) params.set('query', input.query.slice(0, 255))
			if (input.continuation) params.set('continuation', input.continuation)
			const body = await call(accessToken, `/designs?${params}`)
			const items = Array.isArray(body.items) ? body.items : []
			return {
				designs: items
					.map(toDesign)
					.filter((design): design is CanvaDesign => design !== null),
				continuation:
					typeof body.continuation === 'string' ? body.continuation : null,
			}
		},

		async getDesign(designId: string): Promise<CanvaDesign> {
			const body = await call(
				accessToken,
				`/designs/${encodeURIComponent(designId)}`,
			)
			const design = toDesign(body.design)
			if (!design) throw new CanvaError('not_found', 'No such design')
			return design
		},

		/** Exports page 1 and returns its download URL (valid 24 hours). */
		async exportFirstPage(
			designId: string,
			format: CanvaExportFormat,
		): Promise<string> {
			const body = await call(accessToken, '/exports', {
				method: 'POST',
				body: JSON.stringify({
					design_id: designId,
					format:
						format.type === 'pdf'
							? { type: 'pdf', export_quality: format.quality, pages: [1] }
							: { type: 'png', width: format.width, pages: [1] },
				}),
			})
			const job = await pollJob(accessToken, '/exports', body)
			const urls = Array.isArray(job.urls) ? job.urls : []
			if (typeof urls[0] !== 'string') {
				throw new CanvaError('failed', 'Canva returned no file')
			}
			return urls[0]
		},

		/** Imports a PDF as a new Canva design (owned by this user). */
		async importPdf(
			bytes: Uint8Array<ArrayBuffer>,
			title: string,
		): Promise<{ id: string; editUrl: string | null }> {
			const body = await call(accessToken, '/imports', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/octet-stream',
					'Import-Metadata': JSON.stringify({
						title_base64: Buffer.from(title.slice(0, 50)).toString('base64'),
						mime_type: 'application/pdf',
					}),
				},
				body: bytes,
			})
			const job = await pollJob(accessToken, '/imports', body)
			const result = job.result as Record<string, unknown> | undefined
			const designs = Array.isArray(result?.designs) ? result.designs : []
			const design = toDesign(designs[0])
			if (!design) throw new CanvaError('failed', 'Canva made no design')
			return { id: design.id, editUrl: design.editUrl }
		},
	}
}

export type CanvaApi = ReturnType<typeof canvaApi>

/**
 * Hosts Canva serves export downloads and thumbnails from. A link (or a
 * redirect) anywhere else, an IP literal included, is refused, so a bad API
 * answer cannot point this server at an internal address.
 */
function isCanvaFileHost(url: URL) {
	const host = url.hostname.toLowerCase()
	return (
		url.protocol === 'https:' &&
		!url.port &&
		(host === 'canva.com' || host.endsWith('.canva.com'))
	)
}

/**
 * Downloads a file Canva handed out (an export or a thumbnail): https on a
 * Canva host only (each redirect checked again, at most three), a time limit
 * and a size cap, so a bad link cannot hold the request or fill memory.
 */
export async function downloadCanvaFile(
	url: string,
	options: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: string }> {
	if (isCanvaMock()) return mockCanva.download(url)
	const maxBytes = options.maxBytes ?? PRINT_ARTWORK_MAX_BYTES
	let parsed: URL
	try {
		parsed = new URL(url)
	} catch {
		throw new CanvaError('failed', 'Canva returned a bad link')
	}
	if (!isCanvaFileHost(parsed)) {
		throw new CanvaError('failed', 'Canva returned a bad link')
	}
	const signal = AbortSignal.timeout(options.timeoutMs ?? 60_000)
	let response: Response
	for (let hops = 0; ; hops += 1) {
		try {
			response = await fetch(parsed, { redirect: 'manual', signal })
		} catch {
			throw new CanvaError('unavailable', 'The Canva file did not download')
		}
		const target = response.headers.get('Location')
		if (response.status < 300 || response.status >= 400 || !target) break
		const next = URL.canParse(target, parsed) ? new URL(target, parsed) : null
		if (hops >= 3 || !next || !isCanvaFileHost(next)) {
			throw new CanvaError('failed', 'Canva returned a bad link')
		}
		parsed = next
	}
	if (!response.ok || !response.body) {
		throw new CanvaError('unavailable', 'The Canva file did not download')
	}
	const declared = Number(response.headers.get('content-length') ?? 0)
	if (declared > maxBytes)
		throw new CanvaError('too_large', 'The file is too large')
	const reader = response.body.getReader()
	const chunks: Uint8Array[] = []
	let size = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		size += value.byteLength
		if (size > maxBytes) {
			await reader.cancel().catch(() => {})
			throw new CanvaError('too_large', 'The file is too large')
		}
		chunks.push(value)
	}
	const bytes = new Uint8Array(new ArrayBuffer(size))
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	return {
		bytes,
		contentType: (response.headers.get('content-type') ?? '').split(';')[0]!,
	}
}
