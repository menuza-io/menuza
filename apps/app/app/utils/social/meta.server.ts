import crypto from 'node:crypto'
import { metaRedirectUri, isSocialMock, socialEnv } from './env.server.ts'
import { SocialError } from './errors.ts'
import { mockMeta } from './mock.server.ts'
import { type SocialPlatform } from './platforms.ts'

/**
 * Meta Graph API client for Facebook Pages and Instagram professional
 * accounts. Members sign in with Facebook (Facebook Login); the App keeps the
 * Page access tokens, which do not expire when they come from a long-lived
 * user token. Every call goes from the App server, never the browser. Under
 * `SOCIAL_MOCK` (local only) the same functions answer from `mock.server.ts`.
 */

const GRAPH_VERSION = 'v23.0'
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`
const DIALOG = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`

/** Instagram container processing is polled for at most this long. */
const CONTAINER_WAIT_MS = 60_000
const CONTAINER_POLL_MS = 2_000

/** What each platform asks the member to allow. */
export const META_SCOPES: Record<SocialPlatform, readonly string[]> = {
	facebook: [
		'pages_show_list',
		'pages_read_engagement',
		'pages_manage_posts',
		'business_management',
	],
	instagram: [
		'pages_show_list',
		'pages_read_engagement',
		'instagram_basic',
		'instagram_content_publish',
		'business_management',
	],
}

export type MetaAccount = {
	platform: SocialPlatform
	externalId: string
	name: string
	username: string | null
	accessToken: string
}

export type SocialPublishInput = {
	body: string
	/** Public https URLs of JPEG images, in order. */
	imageUrls: string[]
}

export type SocialPublishResult = {
	externalPostId: string
	permalink: string | null
}

type GraphError = {
	message?: unknown
	error_user_msg?: unknown
	code?: unknown
}

function graphError(status: number, error: GraphError | undefined) {
	const code = Number(error?.code)
	const message =
		(typeof error?.error_user_msg === 'string' && error.error_user_msg) ||
		(typeof error?.message === 'string' && error.message) ||
		`Meta request failed (${status})`
	// 190: token expired or revoked; 10 and 200-299: a permission is missing.
	if (code === 190 || code === 102 || code === 10 || (code >= 200 && code < 300)) {
		return new SocialError('unauthorized', message, status)
	}
	if ([4, 17, 32, 613, 80001, 80002].includes(code) || status === 429) {
		return new SocialError('rate_limited', message, status)
	}
	if (status >= 500 || code === 1 || code === 2) {
		return new SocialError('unavailable', message, status)
	}
	return new SocialError('rejected', message, status)
}

/** Proves the call comes from the app's server (Meta's "Require App Secret"). */
function appSecretProof(token: string) {
	return crypto
		.createHmac('sha256', socialEnv('META_APP_SECRET'))
		.update(token)
		.digest('hex')
}

async function graph<T>(
	path: string,
	options: {
		method?: 'GET' | 'POST'
		token?: string
		params?: Record<string, string>
	} = {},
): Promise<T> {
	const method = options.method ?? 'GET'
	const params = new URLSearchParams(options.params)
	if (options.token) params.set('appsecret_proof', appSecretProof(options.token))
	const url = new URL(`${GRAPH}${path}`)
	if (method === 'GET') url.search = params.toString()
	let response: Response
	try {
		response = await fetch(url, {
			method,
			headers: {
				...(options.token
					? { Authorization: `Bearer ${options.token}` }
					: {}),
				...(method === 'POST'
					? { 'Content-Type': 'application/x-www-form-urlencoded' }
					: {}),
			},
			body: method === 'POST' ? params : undefined,
			redirect: 'error',
			signal: AbortSignal.timeout(30_000),
		})
	} catch {
		throw new SocialError('unavailable', 'meta_unavailable')
	}
	const json = (await response.json().catch(() => null)) as
		| (Record<string, unknown> & { error?: GraphError })
		| null
	if (!response.ok || !json || json.error) {
		throw graphError(response.status, json?.error)
	}
	return json as T
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

export function metaAuthorizeUrl(input: {
	state: string
	platform: SocialPlatform
}): string {
	const url = new URL(DIALOG)
	url.searchParams.set('client_id', socialEnv('META_APP_ID'))
	url.searchParams.set('redirect_uri', metaRedirectUri())
	url.searchParams.set('state', input.state)
	url.searchParams.set('response_type', 'code')
	url.searchParams.set('scope', META_SCOPES[input.platform].join(','))
	return url.toString()
}

/** Trades the code for a long-lived user token (about 60 days). */
export async function exchangeMetaCode(code: string): Promise<string> {
	if (isSocialMock()) return mockMeta.userToken()
	const clientId = socialEnv('META_APP_ID')
	const clientSecret = socialEnv('META_APP_SECRET')
	if (!clientId || !clientSecret) {
		throw new SocialError('unavailable', 'Meta is not configured')
	}
	const short = await graph<{ access_token?: unknown }>('/oauth/access_token', {
		params: {
			client_id: clientId,
			client_secret: clientSecret,
			redirect_uri: metaRedirectUri(),
			code,
		},
	})
	if (typeof short.access_token !== 'string') {
		throw new SocialError('unavailable', 'Meta sent no token')
	}
	const long = await graph<{ access_token?: unknown }>('/oauth/access_token', {
		params: {
			grant_type: 'fb_exchange_token',
			client_id: clientId,
			client_secret: clientSecret,
			fb_exchange_token: short.access_token,
		},
	})
	if (typeof long.access_token !== 'string') {
		throw new SocialError('unavailable', 'Meta sent no token')
	}
	return long.access_token
}

type PageRow = {
	id?: unknown
	name?: unknown
	access_token?: unknown
	instagram_business_account?: {
		id?: unknown
		username?: unknown
		name?: unknown
	}
}

/**
 * The Pages (or the Instagram accounts linked to them) the member allowed,
 * each with its Page access token. Instagram publishing uses the token of the
 * Page the account is linked to.
 */
export async function listMetaAccounts(
	userToken: string,
	platform: SocialPlatform,
): Promise<MetaAccount[]> {
	if (isSocialMock()) return mockMeta.accounts(platform)
	const accounts: MetaAccount[] = []
	let after: string | null = null
	for (let page = 0; page < 10; page++) {
		const result: {
			data?: PageRow[]
			paging?: { cursors?: { after?: unknown }; next?: unknown }
		} = await graph('/me/accounts', {
			token: userToken,
			params: {
				fields:
					'id,name,access_token,instagram_business_account{id,username,name}',
				limit: '100',
				...(after ? { after } : {}),
			},
		})
		for (const row of result.data ?? []) {
			if (typeof row.id !== 'string' || typeof row.access_token !== 'string') {
				continue
			}
			if (platform === 'facebook') {
				accounts.push({
					platform,
					externalId: row.id,
					name: typeof row.name === 'string' ? row.name : row.id,
					username: null,
					accessToken: row.access_token,
				})
				continue
			}
			const instagram = row.instagram_business_account
			if (instagram && typeof instagram.id === 'string') {
				const username =
					typeof instagram.username === 'string' ? instagram.username : null
				accounts.push({
					platform,
					externalId: instagram.id,
					name:
						(typeof instagram.name === 'string' && instagram.name) ||
						username ||
						instagram.id,
					username,
					accessToken: row.access_token,
				})
			}
		}
		const next = result.paging?.cursors?.after
		if (!result.paging?.next || typeof next !== 'string') break
		after = next
	}
	return accounts
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

async function permalinkOf(id: string, field: string, token: string) {
	try {
		const result = await graph<Record<string, unknown>>(`/${id}`, {
			token,
			params: { fields: field },
		})
		const link = result[field]
		return typeof link === 'string' && link.startsWith('https://') ? link : null
	} catch {
		return null
	}
}

export async function publishToFacebook(
	account: { externalId: string; accessToken: string },
	input: SocialPublishInput,
): Promise<SocialPublishResult> {
	if (isSocialMock()) return mockMeta.publish('facebook', input)
	const token = account.accessToken
	const page = encodeURIComponent(account.externalId)
	let postId: string
	if (input.imageUrls.length === 0) {
		const result = await graph<{ id: string }>(`/${page}/feed`, {
			method: 'POST',
			token,
			params: { message: input.body },
		})
		postId = result.id
	} else if (input.imageUrls.length === 1) {
		const result = await graph<{ id: string; post_id?: string }>(
			`/${page}/photos`,
			{
				method: 'POST',
				token,
				params: { url: input.imageUrls[0]!, caption: input.body },
			},
		)
		postId = result.post_id ?? result.id
	} else {
		// Several photos: upload each unpublished, then one post with all.
		const photoIds: string[] = []
		for (const url of input.imageUrls) {
			const photo = await graph<{ id: string }>(`/${page}/photos`, {
				method: 'POST',
				token,
				params: { url, published: 'false' },
			})
			photoIds.push(photo.id)
		}
		const params: Record<string, string> = { message: input.body }
		photoIds.forEach((id, index) => {
			params[`attached_media[${index}]`] = JSON.stringify({ media_fbid: id })
		})
		const result = await graph<{ id: string }>(`/${page}/feed`, {
			method: 'POST',
			token,
			params,
		})
		postId = result.id
	}
	return {
		externalPostId: postId,
		permalink: await permalinkOf(postId, 'permalink_url', token),
	}
}

async function waitForContainer(id: string, token: string) {
	const deadline = Date.now() + CONTAINER_WAIT_MS
	for (;;) {
		const { status_code: status } = await graph<{ status_code?: string }>(
			`/${id}`,
			{ token, params: { fields: 'status_code' } },
		)
		if (status === 'FINISHED' || status === 'PUBLISHED') return
		if (status === 'ERROR' || status === 'EXPIRED') {
			throw new SocialError('rejected', 'image_processing_failed')
		}
		if (Date.now() > deadline) {
			throw new SocialError('unavailable', 'image_processing_slow')
		}
		await new Promise((resolve) => setTimeout(resolve, CONTAINER_POLL_MS))
	}
}

export async function publishToInstagram(
	account: { externalId: string; accessToken: string },
	input: SocialPublishInput,
): Promise<SocialPublishResult> {
	if (isSocialMock()) return mockMeta.publish('instagram', input)
	if (input.imageUrls.length === 0) {
		throw new SocialError('rejected', 'needs_image')
	}
	const token = account.accessToken
	const user = encodeURIComponent(account.externalId)
	let creationId: string
	if (input.imageUrls.length === 1) {
		const container = await graph<{ id: string }>(`/${user}/media`, {
			method: 'POST',
			token,
			params: { image_url: input.imageUrls[0]!, caption: input.body },
		})
		creationId = container.id
	} else {
		const children: string[] = []
		for (const url of input.imageUrls) {
			const child = await graph<{ id: string }>(`/${user}/media`, {
				method: 'POST',
				token,
				params: { image_url: url, is_carousel_item: 'true' },
			})
			children.push(child.id)
		}
		for (const child of children) await waitForContainer(child, token)
		const container = await graph<{ id: string }>(`/${user}/media`, {
			method: 'POST',
			token,
			params: {
				media_type: 'CAROUSEL',
				children: children.join(','),
				caption: input.body,
			},
		})
		creationId = container.id
	}
	await waitForContainer(creationId, token)
	const published = await graph<{ id: string }>(`/${user}/media_publish`, {
		method: 'POST',
		token,
		params: { creation_id: creationId },
	})
	return {
		externalPostId: published.id,
		permalink: await permalinkOf(published.id, 'permalink', token),
	}
}
