import crypto from 'node:crypto'
import { and, count, eq, gte, notInArray } from 'drizzle-orm'

import {
	QR_SETTINGS_DEFAULTS,
	type QrSettingsView,
	type QrTabTotals,
} from '@repo/common/qr-ordering'
import {
	qrSettings,
	qrTables,
	qrTabs,
	restaurantOrders,
	type QrTableRow,
	type QrTabRow,
	type RestaurantOrder,
	type TenantDatabase,
	type TenantTransaction,
} from '@repo/tenant-db'

import { inJsonList } from '../lib/chunked-in.ts'
import { readTableToken, readTabToken } from '../lib/qr-tokens.ts'

/**
 * Dine-in helpers shared by order placement and the tab service. They take a
 * database or transaction handle and never lock on their own: callers run
 * them inside `runExclusive` + `runTenantTransaction` with the order write.
 */

type Db = TenantDatabase | TenantTransaction

export type DineInFailure = {
	status: number
	code: string
	message: string
	/** Machine-readable extras for the client (e.g. the corrected discount). */
	details?: Record<string, unknown>
}

function failure(status: number, code: string, message: string): DineInFailure {
	return { status, code, message }
}

/** Header capabilities a dine-in request may present (raw, unverified). */
export type DineInCapability = {
	tableToken?: string | null
	tabToken?: string | null
}

/** Rounds that no longer count toward a tab's total. */
export const QR_ROUND_VOID_STATUSES = ['cancelled', 'expired'] as const

/** Rounds the kitchen is still working on: a guest cannot pay online yet. */
export const QR_ROUND_PENDING_STATUSES = ['accepted', 'preparing'] as const

export async function readQrSettings(db: Db): Promise<QrSettingsView> {
	const [row] = await db
		.select()
		.from(qrSettings)
		.where(eq(qrSettings.id, 'default'))
		.limit(1)
	if (!row) return { ...QR_SETTINGS_DEFAULTS }
	return {
		requireGuestName: row.requireGuestName,
		requireGuestPhone: row.requireGuestPhone,
		allowOnlineTabPay: row.allowOnlineTabPay,
		perTableLimitPerHour: row.perTableLimitPerHour,
	}
}

export type ResolvedDineIn = {
	table: QrTableRow
	tab: QrTabRow | null
}

/**
 * Resolves the table (and its open tab) a guest's token proves. A tab token
 * must name an open tab of this org at a live table; a table token must name a
 * live table at the requested location and joins its open tab when there is
 * one, so every phone at the table shares one tab. Burned versions, foreign
 * MACs and unknown ids all read as `table_not_found`.
 */
export async function resolveDineIn(
	db: Db,
	orgId: string,
	capability: DineInCapability,
	locationId: string | null,
): Promise<
	{ ok: true; data: ResolvedDineIn } | { ok: false; failure: DineInFailure }
> {
	const notFound = failure(
		404,
		'table_not_found',
		'This table code is no longer valid. Ask a team member for help.',
	)
	if (capability.tabToken) {
		const parsed = readTabToken(orgId, capability.tabToken)
		if (!parsed) return { ok: false, failure: notFound }
		const [tab] = await db
			.select()
			.from(qrTabs)
			.where(eq(qrTabs.id, parsed.id))
			.limit(1)
		if (!tab || tab.tabTokenVersion !== parsed.version) {
			return { ok: false, failure: notFound }
		}
		if (tab.status !== 'open') {
			return {
				ok: false,
				failure: failure(
					409,
					'tab_closed',
					'This tab is closed. Scan the table code to start a new one.',
				),
			}
		}
		if (tab.lockedAt != null) return { ok: false, failure: lockedFailure() }
		const [table] = await db
			.select()
			.from(qrTables)
			.where(eq(qrTables.id, tab.tableId))
			.limit(1)
		if (!table) return { ok: false, failure: notFound }
		if (locationId && table.locationId !== locationId) {
			return {
				ok: false,
				failure: failure(
					422,
					'table_location_mismatch',
					'This table belongs to another location.',
				),
			}
		}
		return { ok: true, data: { table, tab } }
	}

	if (!capability.tableToken) return { ok: false, failure: notFound }
	const parsed = readTableToken(orgId, capability.tableToken)
	if (!parsed) return { ok: false, failure: notFound }
	const [table] = await db
		.select()
		.from(qrTables)
		.where(eq(qrTables.id, parsed.id))
		.limit(1)
	if (!table || table.tokenVersion !== parsed.version) {
		return { ok: false, failure: notFound }
	}
	if (table.archivedAt != null) {
		return {
			ok: false,
			failure: failure(
				410,
				'table_archived',
				'This table is no longer taking orders. Ask a team member for help.',
			),
		}
	}
	if (locationId && table.locationId !== locationId) {
		return {
			ok: false,
			failure: failure(
				422,
				'table_location_mismatch',
				'This table belongs to another location.',
			),
		}
	}
	const [tab] = await db
		.select()
		.from(qrTabs)
		.where(and(eq(qrTabs.tableId, table.id), eq(qrTabs.status, 'open')))
		.limit(1)
	// A locked tab stays locked for every phone: re-scanning the table code
	// must not hand out a fresh tab token.
	if (tab?.lockedAt != null) return { ok: false, failure: lockedFailure() }
	return { ok: true, data: { table, tab: tab ?? null } }
}

function lockedFailure(): DineInFailure {
	return failure(
		423,
		'tab_locked',
		'A team member is settling this tab. Please ask them for help.',
	)
}

/** Durable per-table burst limit: rounds placed at the table in the last hour. */
export async function tableRoundsInLastHour(
	db: Db,
	tableId: string,
	now: Date,
): Promise<number> {
	const [row] = await db
		.select({ value: count() })
		.from(restaurantOrders)
		.where(
			and(
				eq(restaurantOrders.tableId, tableId),
				gte(restaurantOrders.createdAt, new Date(now.getTime() - 3_600_000)),
			),
		)
	return Number(row?.value ?? 0)
}

function dayKeyOf(now: Date): string {
	const year = now.getUTCFullYear()
	const month = String(now.getUTCMonth() + 1).padStart(2, '0')
	const day = String(now.getUTCDate()).padStart(2, '0')
	return `${year}${month}${day}`
}

function isUniqueConstraintError(error: unknown): boolean {
	return (
		error instanceof Error && error.message.includes('UNIQUE constraint failed')
	)
}

/**
 * Opens a tab at a table. The tab number is a short per-day sequence the guest
 * quotes at the counter. The partial unique index keeps one open tab per
 * table; callers hold the org lock, so a conflict here means a race lost to
 * another writer and is surfaced as `tab_conflict`.
 */
export async function openTab(
	tx: TenantTransaction,
	input: {
		table: QrTableRow
		currency: string
		guestName: string | null
		guestPhone: string | null
		now: Date
	},
): Promise<QrTabRow | null> {
	const openedDay = dayKeyOf(input.now)
	const [row] = await tx
		.select({ value: count() })
		.from(qrTabs)
		.where(eq(qrTabs.openedDay, openedDay))
	const base = Number(row?.value ?? 0)
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const tabNumber = String(base + 1 + attempt).padStart(3, '0')
		try {
			const [inserted] = await tx
				.insert(qrTabs)
				.values({
					id: crypto.randomUUID(),
					tableId: input.table.id,
					locationId: input.table.locationId,
					tableLabel: input.table.label,
					status: 'open',
					tabNumber,
					openedDay,
					guestName: input.guestName,
					guestPhone: input.guestPhone,
					currency: input.currency,
					openedAt: input.now.getTime(),
					updatedAt: input.now.getTime(),
				})
				.returning()
			return inserted ?? null
		} catch (error) {
			if (!isUniqueConstraintError(error)) throw error
			const [open] = await tx
				.select({ id: qrTabs.id })
				.from(qrTabs)
				.where(
					and(eq(qrTabs.tableId, input.table.id), eq(qrTabs.status, 'open')),
				)
				.limit(1)
			if (open) return null
		}
	}
	return null
}

export async function listTabRounds(
	db: Db,
	tabIds: string[],
): Promise<RestaurantOrder[]> {
	if (tabIds.length === 0) return []
	return (
		db
			.select()
			.from(restaurantOrders)
			// One JSON parameter: Durable Object SQLite caps bound values at 100.
			.where(inJsonList(restaurantOrders.tabId, tabIds))
			.orderBy(restaurantOrders.createdAt)
	)
}

/**
 * Running totals from the rounds that still count. A VAT-inclusive round
 * carries tax inside its subtotal, so the total never adds it again. A
 * closed tab answers its settled snapshot (with the reward it was paid with);
 * an open one always reads at full price, the price staff charge.
 */
export function tabTotals(
	tab: Pick<
		QrTabRow,
		| 'currency'
		| 'status'
		| 'subtotalCents'
		| 'taxCents'
		| 'tipCents'
		| 'totalCents'
		| 'loyaltyDiscountCents'
	>,
	rounds: RestaurantOrder[],
	options: { useSnapshot?: boolean } = {},
): QrTabTotals {
	const live = rounds.filter(
		(round) =>
			!(QR_ROUND_VOID_STATUSES as readonly string[]).includes(round.status),
	)
	const taxInclusive = live.some(
		(round) =>
			round.taxCents > 0 &&
			round.totalCents ===
				round.subtotalCents + round.tipCents + round.deliveryFeeCents,
	)
	if (options.useSnapshot && tab.status === 'closed') {
		return {
			currency: tab.currency,
			subtotalCents: tab.subtotalCents,
			taxCents: tab.taxCents,
			taxInclusive,
			tipCents: tab.tipCents,
			loyaltyDiscountCents: tab.loyaltyDiscountCents,
			totalCents: tab.totalCents,
		}
	}
	const subtotalCents = live.reduce(
		(sum, round) => sum + round.subtotalCents,
		0,
	)
	const taxCents = live.reduce((sum, round) => sum + round.taxCents, 0)
	const totalCents = live.reduce((sum, round) => sum + round.totalCents, 0)
	return {
		currency: tab.currency,
		subtotalCents,
		taxCents,
		taxInclusive,
		tipCents: 0,
		loyaltyDiscountCents: 0,
		totalCents,
	}
}

export function roundsPending(rounds: RestaurantOrder[]): boolean {
	return rounds.some((round) =>
		(QR_ROUND_PENDING_STATUSES as readonly string[]).includes(round.status),
	)
}

/** Settles every counting round of a tab as paid (tab close). */
export async function markTabRoundsPaid(
	tx: TenantTransaction,
	tabId: string,
	now: Date,
) {
	await tx
		.update(restaurantOrders)
		.set({ paymentStatus: 'paid', paidAt: now, updatedAt: now })
		.where(
			and(
				eq(restaurantOrders.tabId, tabId),
				notInArray(restaurantOrders.status, [...QR_ROUND_VOID_STATUSES]),
			),
		)
}

/** How long a started tab payment freezes the tab without a provider session. */
export const QR_TAB_PAYMENT_FREEZE_MS = 30 * 60 * 1000

/**
 * How long a bound provider session holds the tab. Tab sessions are created to
 * expire after about 40 minutes; past this a silent session (a closed payment
 * page, a provider that never reports) no longer blocks the table.
 */
export const QR_TAB_SESSION_HOLD_MS = 45 * 60 * 1000

/**
 * True while a tab payment is in progress: a provider session is bound (until
 * it goes stale), or the guest asked to pay recently (the amount is fixed from
 * that moment).
 */
export function isTabPaymentOpen(
	tab: Pick<
		QrTabRow,
		'paymentStatus' | 'paymentAmountCents' | 'paymentEventAt'
	>,
	now: Date,
): boolean {
	const age = now.getTime() - (tab.paymentEventAt ?? 0)
	if (tab.paymentStatus === 'pending') return age < QR_TAB_SESSION_HOLD_MS
	return (
		tab.paymentAmountCents != null &&
		tab.paymentEventAt != null &&
		age < QR_TAB_PAYMENT_FREEZE_MS
	)
}
