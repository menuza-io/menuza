import {
	MENU_POPULAR_MAX_ITEM_IDS,
	MENU_POPULAR_MIN_SOLD,
	MENU_POPULAR_PATH,
	MENU_POPULAR_WINDOW_DAYS,
	type MenuPopularPayload,
	menuPopularPayloadSchema,
	menuPopularResultSchema,
} from '@repo/common/menu-popular'
import {
	getTenantDb,
	marketingSettings,
	type TenantDatabase,
	type TenantTransaction,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { ENV } from 'varlock/env'
import { forEachWithBudget } from '../lib/concurrency.ts'
import { errorLogFields } from '../lib/error-log.ts'
import { getInternalCommandToken, syncEnvFromProcess } from '../lib/secrets.ts'
import { readItemSales } from './item-sales.ts'
import { rotateOrgIds } from './loyalty-tick-service.ts'

export const MENU_POPULAR_LAST_RUN_KEY = 'menu_popular_last_run'
const DAY_MS = 86_400_000
const DEFAULT_BUDGET_MS = 50_000
const RETRYABLE = new Set([401, 408, 425, 429, 500, 502, 503, 504])

export type MenuPopularPostOutcome =
	| { status: 'applied'; updated: number; skipped?: string }
	| { status: 'retry'; code: string }
	| { status: 'rejected'; code: string }

function appUrl(): string {
	syncEnvFromProcess()
	return (ENV.APP_URL || (ENV as { BASE_URL?: string }).BASE_URL || '').replace(
		/\/$/,
		'',
	)
}

export function utcDateString(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10)
}

/**
 * Posts top-selling item IDs (and only `{ orgId, itemIds, windowDays }`) to
 * the US App's internal endpoint (`POST /resources/menu/popular`).
 */
export async function postMenuPopular(
	payload: MenuPopularPayload,
): Promise<MenuPopularPostOutcome> {
	const parsed = menuPopularPayloadSchema.safeParse(payload)
	if (!parsed.success) return { status: 'rejected', code: 'invalid_request' }

	const base = appUrl()
	const token = getInternalCommandToken()
	if (!base || token.length < 16) {
		return { status: 'retry', code: 'not_configured' }
	}

	try {
		const response = await fetch(`${base}${MENU_POPULAR_PATH}`, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(parsed.data),
			redirect: 'error',
			signal: AbortSignal.timeout(8_000),
		})
		if (!response.ok) {
			void response.body?.cancel().catch(() => undefined)
			return {
				status: RETRYABLE.has(response.status) ? 'retry' : 'rejected',
				code: `http_${response.status}`,
			}
		}
		const answer = menuPopularResultSchema.safeParse(
			await response.json().catch(() => null),
		)
		if (!answer.success) return { status: 'rejected', code: 'invalid_answer' }
		return {
			status: 'applied',
			updated: answer.data.updated,
			skipped: answer.data.skipped,
		}
	} catch {
		return { status: 'retry', code: 'network_error' }
	}
}

/**
 * Reads the last `windowDays` (default 28) of counted sales via `readItemSales`
 * and returns ordered top-selling item IDs (or `[]` when total sold dishes is
 * below `minSold` = 20).
 */
export async function computeTopPopularItemIds(
	db: TenantDatabase | TenantTransaction,
	options: {
		now?: number
		windowDays?: number
		minSold?: number
		maxItemIds?: number
	} = {},
): Promise<{ itemIds: string[]; totalSold: number }> {
	const now = options.now ?? Date.now()
	const windowDays = options.windowDays ?? MENU_POPULAR_WINDOW_DAYS
	const minSold = options.minSold ?? MENU_POPULAR_MIN_SOLD
	const maxItemIds = options.maxItemIds ?? MENU_POPULAR_MAX_ITEM_IDS

	const toDate = utcDateString(now)
	const fromDate = utcDateString(now - (windowDays - 1) * DAY_MS)

	const sales = await readItemSales(db, { fromDate, toDate })
	const totalsByItem = new Map<string, number>()
	let totalSold = 0

	for (const row of sales.items) {
		if (row.quantity <= 0) continue
		totalSold += row.quantity
		totalsByItem.set(
			row.itemId,
			(totalsByItem.get(row.itemId) ?? 0) + row.quantity,
		)
	}

	if (totalSold < minSold) {
		return { itemIds: [], totalSold }
	}

	const itemIds = [...totalsByItem.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, maxItemIds)
		.map(([itemId]) => itemId)

	return { itemIds, totalSold }
}

export type MenuPopularOrgTickResult = {
	ran: boolean
	updated: number
	itemIdsCount: number
	skipped?: string
	deferred?: boolean
	errors: number
}

export async function runMenuPopularTickForOrg(
	orgId: string,
	options: {
		now?: number
		force?: boolean
		post?: (payload: MenuPopularPayload) => Promise<MenuPopularPostOutcome>
	} = {},
): Promise<MenuPopularOrgTickResult> {
	const now = options.now ?? Date.now()
	const post = options.post ?? postMenuPopular
	const today = utcDateString(now)

	try {
		const db = await getTenantDb(orgId)
		if (!options.force) {
			const existing = await db
				.select({ value: marketingSettings.value })
				.from(marketingSettings)
				.where(eq(marketingSettings.key, MENU_POPULAR_LAST_RUN_KEY))
				.get()
			const lastDate =
				existing?.value &&
				typeof existing.value === 'object' &&
				'date' in existing.value
					? (existing.value as { date?: unknown }).date
					: null
			if (lastDate === today) {
				return {
					ran: false,
					updated: 0,
					itemIdsCount: 0,
					skipped: 'already_ran_today',
					errors: 0,
				}
			}
		}

		const { itemIds } = await computeTopPopularItemIds(db, { now })
		const outcome = await post({
			orgId,
			itemIds,
			windowDays: MENU_POPULAR_WINDOW_DAYS,
		})

		if (outcome.status === 'retry') {
			return {
				ran: true,
				updated: 0,
				itemIdsCount: itemIds.length,
				deferred: true,
				errors: 1,
			}
		}
		if (outcome.status === 'rejected') {
			console.warn('Menu popular callback rejected by App', {
				orgId,
				code: outcome.code,
			})
			return {
				ran: true,
				updated: 0,
				itemIdsCount: itemIds.length,
				errors: 1,
			}
		}

		await db
			.insert(marketingSettings)
			.values({
				key: MENU_POPULAR_LAST_RUN_KEY,
				value: { date: today, ranAt: now },
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: marketingSettings.key,
				set: {
					value: { date: today, ranAt: now },
					updatedAt: now,
				},
			})

		return {
			ran: true,
			updated: outcome.updated,
			itemIdsCount: itemIds.length,
			skipped: outcome.skipped,
			errors: 0,
		}
	} catch (error) {
		console.error('Menu popular tick failed', {
			orgId,
			...errorLogFields(error),
		})
		return {
			ran: true,
			updated: 0,
			itemIdsCount: 0,
			errors: 1,
		}
	}
}

export async function runMenuPopularTickLogged(
	orgId: string,
): Promise<MenuPopularOrgTickResult | null> {
	try {
		return await runMenuPopularTickForOrg(orgId)
	} catch (error) {
		console.error('Menu popular tick crashed', {
			orgId,
			...errorLogFields(error),
		})
		return null
	}
}

export type MenuPopularTickAggregate = {
	orgs: number
	ran: number
	updated: number
	orgsDeferred: number
	errors: number
}

export async function fanOutMenuPopularTick(options: {
	orgIds: readonly string[]
	run: (orgId: string) => Promise<MenuPopularOrgTickResult | null>
	budgetMs?: number
	concurrency?: number
	now?: () => number
	rotateBucket?: number
}): Promise<MenuPopularTickAggregate> {
	const now = options.now ?? Date.now
	const total: MenuPopularTickAggregate = {
		orgs: 0,
		ran: 0,
		updated: 0,
		orgsDeferred: 0,
		errors: 0,
	}
	const orgIds = rotateOrgIds(
		options.orgIds,
		options.rotateBucket ?? Math.floor(now() / (60 * 60 * 1000)),
	)
	const run = await forEachWithBudget(
		orgIds,
		{
			concurrency: options.concurrency ?? 4,
			deadline: now() + (options.budgetMs ?? DEFAULT_BUDGET_MS),
			now,
		},
		async (orgId) => {
			const result = await options.run(orgId)
			if (!result) {
				total.errors += 1
				return
			}
			total.orgs += 1
			if (result.ran) total.ran += 1
			total.updated += result.updated
			total.errors += result.errors
		},
	)
	total.orgsDeferred = run.skipped
	return total
}
