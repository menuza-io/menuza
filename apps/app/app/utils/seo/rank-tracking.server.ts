/**
 * Local search keywords and weekly rank checks (#182, flag
 * `seo.rank_tracking`, default off). For each keyword a check asks a
 * local-rank provider where the location shows up in Google's map results at
 * each point of a grid around it (5 by 5 points, 1 km apart), and stores the
 * grid and its average. Checks are paid calls: each organization has a
 * monthly budget, and a check over it is skipped and recorded as such.
 *
 * The provider is an interface: tests and local development use the mock;
 * production uses DataForSEO's Google Maps SERP API when
 * `SEO_RANK_API_LOGIN` / `SEO_RANK_API_PASSWORD` are set, and otherwise skips
 * checks as `provider_not_configured`. Business data only.
 */
import { createId } from '@paralleldrive/cuid2'
import { getFeatureFlag } from '@repo/common/feature-flags'
import {
	averageRank,
	buildRankGrid,
	budgetMonth,
	cleanRank,
	DEFAULT_GRID_SIZE,
	DEFAULT_GRID_SPACING_METERS,
	DEFAULT_MONTHLY_CHECK_BUDGET,
	type GridPoint,
	isKeywordDue,
	keywordLocale,
	locationCoordinates,
	formatKeywordPageRef,
	parseKeywordPageRef,
	type RankedPoint,
	REMOVED_KEYWORD_RETENTION_DAYS,
	validateKeyword,
} from '@repo/common/seo-keywords'
import {
	and,
	asc,
	db,
	desc,
	eq,
	isNull,
	lt,
	Organization,
	OrganizationLocation,
	SeoKeyword,
	SeoRankCheck,
	SeoUsage,
	sql,
} from '@repo/database'
import { isLocalUrl } from '@repo/security/local-host'
import { readLiveEnv } from '#app/utils/env.server.ts'

export const RANK_TRACKING_FLAG = 'seo.rank_tracking'
/** Optional per-organization override of the monthly budget (a number). */
export const RANK_BUDGET_FLAG = 'seo.rank_budget'

export async function isRankTrackingEnabled(organizationId: string) {
	return (await getFeatureFlag(RANK_TRACKING_FLAG, { organizationId })) === true
}

export type RankQuery = {
	keyword: string
	locale: 'en' | 'ar'
	points: GridPoint[]
	/** How the restaurant appears in map results. */
	business: { name: string; host: string | null }
}

export interface LocalRankProvider {
	readonly name: string
	/** One rank per point, 1 to 20, or null when not in the top 20. */
	checkGrid(query: RankQuery): Promise<Array<number | null>>
}

/** Deterministic ranks for tests and local development. */
export const mockRankProvider: LocalRankProvider = {
	name: 'mock',
	async checkGrid(query) {
		let seed = 0
		for (const char of query.keyword)
			seed = (seed * 31 + char.charCodeAt(0)) >>> 0
		return query.points.map((_, index) => {
			const value = (seed + index * 7) % 26
			return value === 0 || value > 20 ? null : value
		})
	},
}

/** DataForSEO Google Maps SERP, one live task per grid point. */
export function dataForSeoProvider(
	login: string,
	password: string,
	fetchImpl: typeof fetch = fetch,
): LocalRankProvider {
	const auth = `Basic ${btoa(`${login}:${password}`)}`
	return {
		name: 'dataforseo',
		async checkGrid(query) {
			const ranks: Array<number | null> = []
			for (const point of query.points) {
				const response = await fetchImpl(
					'https://api.dataforseo.com/v3/serp/google/maps/live/advanced',
					{
						method: 'POST',
						headers: {
							Authorization: auth,
							'Content-Type': 'application/json',
						},
						body: JSON.stringify([
							{
								keyword: query.keyword,
								language_code: query.locale,
								location_coordinate: `${point.lat},${point.lng},15z`,
								depth: 20,
							},
						]),
						signal: AbortSignal.timeout(30_000),
					},
				)
				if (!response.ok) throw new Error(`rank_provider_${response.status}`)
				const data = (await response.json()) as {
					tasks?: Array<{
						result?: Array<{
							items?: Array<{
								rank_group?: number
								title?: string
								domain?: string
							}>
						}>
					}>
				}
				const items = data.tasks?.[0]?.result?.[0]?.items ?? []
				const name = query.business.name.toLowerCase()
				const host = query.business.host?.replace(/^www\./, '') ?? null
				const match = items.find(
					(item) =>
						(host && item.domain?.replace(/^www\./, '') === host) ||
						(name && item.title?.toLowerCase().includes(name)),
				)
				ranks.push(cleanRank(match?.rank_group))
			}
			return ranks
		},
	}
}

let providerOverride: LocalRankProvider | null | undefined

/** Tests set the provider; `undefined` restores the default. */
export function setRankProvider(
	provider: LocalRankProvider | null | undefined,
) {
	providerOverride = provider
}

export function rankProvider(): LocalRankProvider | null {
	if (providerOverride !== undefined) return providerOverride
	const login = readLiveEnv('SEO_RANK_API_LOGIN')
	const password = readLiveEnv('SEO_RANK_API_PASSWORD')
	if (login && password) return dataForSeoProvider(login, password)
	// No vendor keys: the mock on a local deployment, nothing in production.
	return isLocalUrl(readLiveEnv('BASE_URL')) ? mockRankProvider : null
}

async function monthlyBudget(organizationId: string): Promise<number> {
	const value = await getFeatureFlag(RANK_BUDGET_FLAG, { organizationId })
	if (value === null || value === undefined || value === '') {
		return DEFAULT_MONTHLY_CHECK_BUDGET
	}
	const n = typeof value === 'number' ? value : Number(value)
	return Number.isInteger(n) && n >= 0 ? n : DEFAULT_MONTHLY_CHECK_BUDGET
}

export type KeywordError =
	| 'keyword_too_short'
	| 'keyword_too_long'
	| 'keyword_exists'
	| 'too_many_keywords'
	| 'location_not_found'
	| 'keyword_not_found'
	| 'invalid_page'

async function activeKeywords(organizationId: string, locationId: string) {
	return db
		.select({
			id: SeoKeyword.id,
			phrase: SeoKeyword.phrase,
			isPrimary: SeoKeyword.isPrimary,
		})
		.from(SeoKeyword)
		.where(
			and(
				eq(SeoKeyword.organizationId, organizationId),
				eq(SeoKeyword.organizationLocationId, locationId),
				isNull(SeoKeyword.deletedAt),
			),
		)
		.orderBy(asc(SeoKeyword.createdAt))
}

/** Adds a keyword; the first one of a location is its primary. */
export async function addKeyword(input: {
	organizationId: string
	locationId: string
	phrase: string
	pageRef?: string | null
	isPrimary?: boolean
}): Promise<{ ok: true; id: string } | { ok: false; error: KeywordError }> {
	const [location] = await db
		.select({ id: OrganizationLocation.id })
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.id, input.locationId),
				eq(OrganizationLocation.organizationId, input.organizationId),
			),
		)
		.limit(1)
	if (!location) return { ok: false, error: 'location_not_found' }
	const pageRef = input.pageRef ? parseKeywordPageRef(input.pageRef) : null
	if (input.pageRef && !pageRef) return { ok: false, error: 'invalid_page' }
	const existing = await activeKeywords(input.organizationId, input.locationId)
	const valid = validateKeyword(
		input.phrase,
		existing.map((row) => row.phrase),
	)
	if (!valid.ok) return valid
	const primary = existing.length === 0 || input.isPrimary === true
	const statements = []
	if (primary && existing.length) {
		statements.push(
			db
				.update(SeoKeyword)
				.set({ isPrimary: false })
				.where(
					and(
						eq(SeoKeyword.organizationId, input.organizationId),
						eq(SeoKeyword.organizationLocationId, input.locationId),
					),
				),
		)
	}
	const id = createId()
	statements.push(
		db.insert(SeoKeyword).values({
			id,
			organizationId: input.organizationId,
			organizationLocationId: input.locationId,
			phrase: valid.phrase,
			locale: keywordLocale(valid.phrase),
			isPrimary: primary,
			pageRef: pageRef ? formatKeywordPageRef(pageRef) : null,
		}),
	)
	try {
		const [first, ...rest] = statements
		await db.batch([first!, ...rest])
	} catch (error) {
		// Two tabs adding the same phrase: the unique index is the last word.
		if (String(error).includes('UNIQUE'))
			return { ok: false, error: 'keyword_exists' }
		throw error
	}
	return { ok: true, id }
}

async function findKeyword(organizationId: string, keywordId: string) {
	const [row] = await db
		.select({
			id: SeoKeyword.id,
			locationId: SeoKeyword.organizationLocationId,
			isPrimary: SeoKeyword.isPrimary,
		})
		.from(SeoKeyword)
		.where(
			and(
				eq(SeoKeyword.id, keywordId),
				eq(SeoKeyword.organizationId, organizationId),
				isNull(SeoKeyword.deletedAt),
			),
		)
		.limit(1)
	return row ?? null
}

/** Exactly one primary keyword per location. */
export async function setPrimaryKeyword(
	organizationId: string,
	keywordId: string,
) {
	const keyword = await findKeyword(organizationId, keywordId)
	if (!keyword)
		return { ok: false as const, error: 'keyword_not_found' as const }
	await db.batch([
		db
			.update(SeoKeyword)
			.set({ isPrimary: false })
			.where(
				and(
					eq(SeoKeyword.organizationId, organizationId),
					eq(SeoKeyword.organizationLocationId, keyword.locationId),
				),
			),
		db
			.update(SeoKeyword)
			.set({ isPrimary: true })
			.where(eq(SeoKeyword.id, keywordId)),
	])
	return { ok: true as const }
}

export async function setKeywordPage(
	organizationId: string,
	keywordId: string,
	pageRef: string | null,
) {
	const keyword = await findKeyword(organizationId, keywordId)
	if (!keyword)
		return { ok: false as const, error: 'keyword_not_found' as const }
	const parsed = pageRef ? parseKeywordPageRef(pageRef) : null
	if (pageRef && !parsed)
		return { ok: false as const, error: 'invalid_page' as const }
	await db
		.update(SeoKeyword)
		.set({ pageRef: parsed ? formatKeywordPageRef(parsed) : null })
		.where(eq(SeoKeyword.id, keywordId))
	return { ok: true as const }
}

/**
 * Removes a keyword from the list; its history is kept for 90 days. A
 * removed primary hands the role to the oldest remaining keyword.
 */
export async function removeKeyword(
	organizationId: string,
	keywordId: string,
	now = new Date(),
) {
	const keyword = await findKeyword(organizationId, keywordId)
	if (!keyword)
		return { ok: false as const, error: 'keyword_not_found' as const }
	await db
		.update(SeoKeyword)
		.set({ deletedAt: now, isPrimary: false })
		.where(eq(SeoKeyword.id, keywordId))
	if (keyword.isPrimary) {
		const [next] = await activeKeywords(organizationId, keyword.locationId)
		if (next) {
			await db
				.update(SeoKeyword)
				.set({ isPrimary: true })
				.where(eq(SeoKeyword.id, next.id))
		}
	}
	return { ok: true as const }
}

type CheckOutcome =
	| 'checked'
	| 'skipped_budget'
	| 'skipped_coordinates'
	| 'skipped_provider'
	| 'failed'

async function recordCheck(values: typeof SeoRankCheck.$inferInsert) {
	await db.insert(SeoRankCheck).values(values)
}

async function bumpUsage(
	organizationId: string,
	month: string,
	field: 'checks' | 'skipped',
) {
	await db
		.insert(SeoUsage)
		.values({
			organizationId,
			month,
			checks: field === 'checks' ? 1 : 0,
			skipped: field === 'skipped' ? 1 : 0,
		})
		.onConflictDoUpdate({
			target: [SeoUsage.organizationId, SeoUsage.month],
			set:
				field === 'checks'
					? { checks: sql`${SeoUsage.checks} + 1` }
					: { skipped: sql`${SeoUsage.skipped} + 1` },
		})
}

async function usedThisMonth(organizationId: string, month: string) {
	const [row] = await db
		.select({ checks: SeoUsage.checks })
		.from(SeoUsage)
		.where(
			and(
				eq(SeoUsage.organizationId, organizationId),
				eq(SeoUsage.month, month),
			),
		)
		.limit(1)
	return row?.checks ?? 0
}

/**
 * Checks one organization's due keywords (never checked, or a week since the
 * last check), within its monthly budget.
 */
export async function runOrganizationRankChecks(
	organization: { id: string; name: string; customDomain: string | null },
	now = new Date(),
): Promise<Record<CheckOutcome, number>> {
	const outcome: Record<CheckOutcome, number> = {
		checked: 0,
		skipped_budget: 0,
		skipped_coordinates: 0,
		skipped_provider: 0,
		failed: 0,
	}
	const keywords = await db
		.select({
			id: SeoKeyword.id,
			phrase: SeoKeyword.phrase,
			locale: SeoKeyword.locale,
			address: OrganizationLocation.address,
			locationName: OrganizationLocation.name,
			lastCheckedAt: sql<
				number | null
			>`(select max(${SeoRankCheck.checkedAt}) from ${SeoRankCheck} where ${SeoRankCheck.keywordId} = ${SeoKeyword.id})`,
		})
		.from(SeoKeyword)
		.innerJoin(
			OrganizationLocation,
			eq(OrganizationLocation.id, SeoKeyword.organizationLocationId),
		)
		.where(
			and(
				eq(SeoKeyword.organizationId, organization.id),
				isNull(SeoKeyword.deletedAt),
			),
		)
		.orderBy(desc(SeoKeyword.isPrimary), asc(SeoKeyword.createdAt))
	const month = budgetMonth(now)
	const budget = await monthlyBudget(organization.id)
	let used = await usedThisMonth(organization.id, month)
	const provider = rankProvider()
	for (const keyword of keywords) {
		const last = keyword.lastCheckedAt
			? new Date(Number(keyword.lastCheckedAt))
			: null
		if (!isKeywordDue(last, now)) continue
		const base = {
			organizationId: organization.id,
			keywordId: keyword.id,
			checkedAt: now,
			gridSize: DEFAULT_GRID_SIZE,
			spacingMeters: DEFAULT_GRID_SPACING_METERS,
		}
		const center = locationCoordinates(keyword.address)
		if (!center) {
			await recordCheck({
				...base,
				status: 'skipped',
				reason: 'location_missing_coordinates',
			})
			outcome.skipped_coordinates++
			continue
		}
		if (used >= budget) {
			// Reported on the screen and in the job's answer; not charged.
			await recordCheck({
				...base,
				status: 'skipped',
				reason: 'budget_exhausted',
			})
			await bumpUsage(organization.id, month, 'skipped')
			outcome.skipped_budget++
			continue
		}
		if (!provider) {
			await recordCheck({
				...base,
				status: 'skipped',
				reason: 'provider_not_configured',
			})
			outcome.skipped_provider++
			continue
		}
		const grid = buildRankGrid(center)
		try {
			const ranks = await provider.checkGrid({
				keyword: keyword.phrase,
				locale: keyword.locale === 'ar' ? 'ar' : 'en',
				points: grid,
				business: { name: organization.name, host: organization.customDomain },
			})
			const points: RankedPoint[] = grid.map((point, index) => ({
				...point,
				rank: cleanRank(ranks[index]),
			}))
			await recordCheck({
				...base,
				status: 'ok',
				averageRank: averageRank(points),
				points: JSON.stringify(points),
			})
			await bumpUsage(organization.id, month, 'checks')
			used++
			outcome.checked++
		} catch {
			await recordCheck({ ...base, status: 'failed', reason: 'provider_error' })
			outcome.failed++
		}
	}
	return outcome
}

/** Drops keywords removed more than 90 days ago, with their history. */
export async function purgeRemovedKeywords(now = new Date()) {
	const cutoff = new Date(
		now.getTime() - REMOVED_KEYWORD_RETENTION_DAYS * 86_400_000,
	)
	await db.delete(SeoKeyword).where(lt(SeoKeyword.deletedAt, cutoff))
}

/** The weekly job: every organization with the flag on at organization level. */
export async function runRankChecks(now = new Date()) {
	const organizations = await db
		.selectDistinct({
			id: Organization.id,
			name: Organization.name,
			customDomain: Organization.customDomain,
		})
		.from(SeoKeyword)
		.innerJoin(Organization, eq(Organization.id, SeoKeyword.organizationId))
		.where(and(isNull(SeoKeyword.deletedAt), eq(Organization.active, true)))
	const totals: Record<CheckOutcome, number> & { organizations: number } = {
		organizations: 0,
		checked: 0,
		skipped_budget: 0,
		skipped_coordinates: 0,
		skipped_provider: 0,
		failed: 0,
	}
	for (const organization of organizations) {
		if (!(await isRankTrackingEnabled(organization.id))) continue
		totals.organizations++
		const outcome = await runOrganizationRankChecks(organization, now)
		for (const key of Object.keys(outcome) as CheckOutcome[])
			totals[key] += outcome[key]
	}
	await purgeRemovedKeywords(now)
	return totals
}

/** Keyword screen data: keywords per location with their check history. */
export async function loadKeywordScreen(
	organizationId: string,
	now = new Date(),
) {
	const [keywords, checks, usage, budget] = await Promise.all([
		db
			.select({
				id: SeoKeyword.id,
				locationId: SeoKeyword.organizationLocationId,
				phrase: SeoKeyword.phrase,
				locale: SeoKeyword.locale,
				isPrimary: SeoKeyword.isPrimary,
				pageRef: SeoKeyword.pageRef,
				createdAt: SeoKeyword.createdAt,
			})
			.from(SeoKeyword)
			.where(
				and(
					eq(SeoKeyword.organizationId, organizationId),
					isNull(SeoKeyword.deletedAt),
				),
			)
			.orderBy(desc(SeoKeyword.isPrimary), asc(SeoKeyword.createdAt)),
		db
			.select({
				id: SeoRankCheck.id,
				keywordId: SeoRankCheck.keywordId,
				checkedAt: SeoRankCheck.checkedAt,
				status: SeoRankCheck.status,
				reason: SeoRankCheck.reason,
				averageRank: SeoRankCheck.averageRank,
				points: SeoRankCheck.points,
				gridSize: SeoRankCheck.gridSize,
			})
			.from(SeoRankCheck)
			.where(eq(SeoRankCheck.organizationId, organizationId))
			.orderBy(desc(SeoRankCheck.checkedAt))
			.limit(500),
		usedThisMonth(organizationId, budgetMonth(now)),
		monthlyBudget(organizationId),
	])
	return {
		keywords: keywords.map((keyword) => {
			const history = checks
				.filter((check) => check.keywordId === keyword.id)
				.slice(0, 26)
				.map((check) => ({
					id: check.id,
					checkedAt: check.checkedAt.toISOString(),
					status: check.status,
					reason: check.reason,
					averageRank: check.averageRank,
					gridSize: check.gridSize,
					points: safePoints(check.points),
				}))
			return { ...keyword, createdAt: keyword.createdAt.toISOString(), history }
		}),
		usage: { used: usage, budget },
	}
}

function safePoints(value: string): RankedPoint[] {
	try {
		const parsed: unknown = JSON.parse(value)
		return Array.isArray(parsed) ? (parsed as RankedPoint[]) : []
	} catch {
		return []
	}
}
