import {
	type CustomerAppPlatform,
	type CustomerAppStore,
} from '@repo/common/customer-app'
import { readLiveEnv } from '#app/utils/env.server.ts'
import {
	type AccountAdapter,
	type BuildAdapter,
	type BuildRequest,
	type BuildStart,
	type StoreAdapter,
	type StoreLookup,
	StoreUnreachableError,
	type StoreReview,
	type StoreSnapshot,
} from './adapters.server.ts'

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

const TIMEOUT_MS = 8_000

/**
 * "A started build is a recorded job plus status callbacks." With no pipeline
 * configured the job stays `queued` (recorded) and whatever runner picks it up
 * reports through the build callback. With a GitHub Actions workflow
 * configured (`CUSTOMER_APP_BUILD_REPO`, `_WORKFLOW`, `_TOKEN`) the build is
 * dispatched too. No store submission happens here either way.
 */
export class WorkflowBuildAdapter implements BuildAdapter {
	readonly name: string

	constructor(
		private readonly options: {
			repo: string
			workflow: string
			ref: string
			token: string
		} | null,
		private readonly fetchImpl: FetchLike = fetch,
	) {
		this.name = options ? 'github-workflow' : 'recorded'
	}

	async start(request: BuildRequest): Promise<BuildStart> {
		if (!this.options) return { externalBuildId: null, logUrl: null }
		const { repo, workflow, ref, token } = this.options
		const response = await this.fetchImpl(
			`https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: 'application/vnd.github+json',
					'Content-Type': 'application/json',
					'X-GitHub-Api-Version': '2022-11-28',
				},
				body: JSON.stringify({
					ref,
					inputs: {
						tenant: request.slug,
						release: request.release,
						platform: request.platform,
						build_id: request.buildId,
						config_url: request.configUrl,
						callback_url: request.callbackUrl,
						callback_token: request.callbackAuthorization?.replace(
							/^Bearer\s+/i,
							'',
						),
					},
				}),
				redirect: 'manual',
				signal: AbortSignal.timeout(TIMEOUT_MS),
			},
		)
		if (response.status !== 204) {
			throw new Error(`dispatch_${response.status}`)
		}
		return {
			externalBuildId: null,
			logUrl: `https://github.com/${repo}/actions/workflows/${workflow}`,
		}
	}
}

export function liveBuildAdapter(): BuildAdapter {
	const repo = readLiveEnv('CUSTOMER_APP_BUILD_REPO')
	const workflow = readLiveEnv('CUSTOMER_APP_BUILD_WORKFLOW')
	const token = readLiveEnv('CUSTOMER_APP_BUILD_TOKEN')
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !workflow || !token) {
		return new WorkflowBuildAdapter(null)
	}
	return new WorkflowBuildAdapter({
		repo,
		workflow,
		token,
		ref: readLiveEnv('CUSTOMER_APP_BUILD_REF') || 'main',
	})
}

function toRatingX100(value: unknown): number | null {
	return typeof value === 'number' && value > 0 && value <= 5
		? Math.round(value * 100)
		: null
}

/**
 * Public store data without credentials: Apple's lookup (status, version,
 * rating, number of ratings) and customer-reviews feed, and Google Play's
 * public listing page (live or removed). Play's version, rating and reviews
 * need the Play Developer API, so those stay empty until that account is
 * connected. A store that cannot be reached throws, and the caller keeps the
 * last known state.
 */
export class PublicStoreAdapter implements StoreAdapter {
	readonly name = 'public'

	constructor(private readonly fetchImpl: FetchLike = fetch) {}

	isConfigured() {
		return true
	}

	async fetch(
		app: StoreLookup,
		store: CustomerAppStore,
	): Promise<StoreSnapshot> {
		return store === 'app_store' ? this.apple(app) : this.play(app)
	}

	private async json(url: string): Promise<unknown> {
		let response: Response
		try {
			response = await this.fetchImpl(url, {
				headers: { Accept: 'application/json' },
				redirect: 'follow',
				signal: AbortSignal.timeout(TIMEOUT_MS),
			})
		} catch {
			throw new StoreUnreachableError('unreachable')
		}
		if (!response.ok) throw new StoreUnreachableError('unreachable')
		try {
			return await response.json()
		} catch {
			throw new StoreUnreachableError('bad_response')
		}
	}

	private async apple(app: StoreLookup): Promise<StoreSnapshot> {
		const lookup = (await this.json(
			`https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(app.iosBundleId)}`,
		)) as {
			resultCount?: number
			results?: Array<{
				trackId?: number
				version?: string
				averageUserRating?: number
				userRatingCount?: number
			}>
		}
		const hit = lookup.results?.[0]
		if (!hit) {
			// A link is on the record but the store has nothing: it was removed.
			return {
				store: 'app_store',
				status: app.storeUrls.app_store ? 'removed' : 'unknown',
				version: null,
				ratingX100: null,
				ratingCount: 0,
				reviews: [],
			}
		}
		let reviews: StoreReview[] = []
		if (typeof hit.trackId === 'number') {
			try {
				reviews = parseAppleReviews(
					await this.json(
						`https://itunes.apple.com/us/rss/customerreviews/id=${hit.trackId}/sortBy=mostRecent/json`,
					),
				)
			} catch {
				// Reviews are nice to have; the rest of the snapshot still counts.
			}
		}
		return {
			store: 'app_store',
			status: 'live',
			version: typeof hit.version === 'string' ? hit.version : null,
			ratingX100: toRatingX100(hit.averageUserRating),
			ratingCount: Number(hit.userRatingCount ?? 0),
			reviews,
		}
	}

	private async play(app: StoreLookup): Promise<StoreSnapshot> {
		let response: Response
		try {
			response = await this.fetchImpl(
				`https://play.google.com/store/apps/details?id=${encodeURIComponent(app.androidPackage)}`,
				{ redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) },
			)
		} catch {
			throw new StoreUnreachableError('unreachable')
		}
		if (response.status === 404) {
			return {
				store: 'play_store',
				status: app.storeUrls.play_store ? 'removed' : 'unknown',
				version: null,
				ratingX100: null,
				ratingCount: 0,
				reviews: [],
			}
		}
		if (!response.ok) throw new StoreUnreachableError('unreachable')
		const html = await response.text()
		const packageInPage = html.includes(app.androidPackage)
		return {
			store: 'play_store',
			status: packageInPage ? 'live' : 'unknown',
			version: null,
			ratingX100: null,
			ratingCount: 0,
			reviews: [],
		}
	}
}

/** Apple's customer reviews feed; the first entry is the app itself and is skipped. */
export function parseAppleReviews(feed: unknown): StoreReview[] {
	const entries = (feed as { feed?: { entry?: unknown } } | null)?.feed?.entry
	if (!Array.isArray(entries)) return []
	const reviews: StoreReview[] = []
	for (const entry of entries) {
		const e = entry as Record<string, { label?: unknown } | undefined>
		const rating = Number(e['im:rating']?.label)
		const id = e.id?.label
		const body = e.content?.label
		if (
			!Number.isInteger(rating) ||
			rating < 1 ||
			rating > 5 ||
			typeof id !== 'string' ||
			typeof body !== 'string'
		) {
			continue
		}
		const at = Date.parse(String(e.updated?.label ?? ''))
		reviews.push({
			externalId: id.slice(0, 200),
			rating,
			title:
				typeof e.title?.label === 'string' ? e.title.label.slice(0, 200) : null,
			body: body.slice(0, 4_000),
			appVersion:
				typeof e['im:version']?.label === 'string'
					? e['im:version'].label.slice(0, 40)
					: null,
			reviewedAt: Number.isFinite(at) ? at : Date.now(),
		})
	}
	return reviews.slice(0, 50)
}

/**
 * Store account facts need the store's developer API, which Menuza connects
 * per publisher account. Until then staff record them by hand in Admin, so the
 * live adapter reports nothing and the last recorded snapshot stays.
 */
export class ManualAccountAdapter implements AccountAdapter {
	readonly name = 'manual'

	isConfigured() {
		return false
	}

	async snapshot() {
		return null
	}
}

export function isPlatform(value: string): value is CustomerAppPlatform {
	return value === 'ios' || value === 'android'
}
