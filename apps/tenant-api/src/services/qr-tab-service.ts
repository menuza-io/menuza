import crypto from 'node:crypto'
import { and, asc, desc, eq, gt, inArray, isNull, ne } from 'drizzle-orm'

import {
	QR_MAX_TABLES_PER_LOCATION,
	readQrOrderingFeatures,
	tabOrderRef,
	type QrPublicTab,
	type QrSettingsPatch,
	type QrSettingsView,
	type QrTableView,
	type QrTabRoundView,
	type QrTabStatus,
	type QrTabTotals,
} from '@repo/common/qr-ordering'
import {
	type PricedOrderLine,
	type RestaurantOrderContext,
} from '@repo/common/restaurant-orders'
import {
	getTenantDb,
	qrSettings,
	qrTabPayments,
	qrTables,
	qrTabs,
	restaurantOrders,
	rsvTables,
	runTenantTransaction,
	type QrTableRow,
	type QrTabRow,
	type RestaurantOrder,
} from '@repo/tenant-db'

import {
	deriveTableToken,
	deriveTabPaymentToken,
	deriveTabToken,
	readTabToken,
} from '../lib/qr-tokens.ts'
import { inJsonList } from '../lib/chunked-in.ts'
import { timingSafeEqualString } from '../lib/secrets.ts'
import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'
import { runExclusive } from './order-service.ts'
import {
	isTabPaymentOpen,
	listTabRounds,
	markTabRoundsPaid,
	QR_ROUND_PENDING_STATUSES,
	readQrSettings,
	resolveDineIn,
	roundsPending,
	tabTotals,
	type DineInCapability,
	type DineInFailure,
} from './qr-dine-in.ts'

/**
 * QR ordering: the table registry, the org's QR settings and the tab
 * lifecycle (open is implicit at the first round; close, void and lock here).
 * Every write runs inside `runExclusive` + `runTenantTransaction`, the same
 * lock order placement takes, so a round and a close never interleave.
 */

export type QrResult<T> =
	{ ok: true; data: T } | { ok: false; failure: DineInFailure }

function fail(status: number, code: string, message: string) {
	return { ok: false as const, failure: { status, code, message } }
}

function isUniqueConstraintError(error: unknown): boolean {
	return (
		error instanceof Error && error.message.includes('UNIQUE constraint failed')
	)
}

async function writeTx<T>(
	orgId: string,
	operation: (
		tx: Parameters<Parameters<typeof runTenantTransaction>[1]>[0],
	) => Promise<T>,
): Promise<T> {
	const db = await getTenantDb(orgId)
	return runExclusive(orgId, () =>
		retryOnSqliteBusy(() => runTenantTransaction(db, operation)),
	)
}

const iso = (ms: number | null | undefined) =>
	ms == null ? null : new Date(ms).toISOString()

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function roundView(round: RestaurantOrder): QrTabRoundView {
	const lines = (round.lines as PricedOrderLine[]) ?? []
	return {
		id: round.id,
		number: round.number,
		status: round.status,
		createdAt: round.createdAt ? round.createdAt.toISOString() : null,
		subtotalCents: round.subtotalCents,
		taxCents: round.taxCents,
		totalCents: round.totalCents,
		lines: lines.map((line) => ({
			itemName: line.itemName,
			quantity: line.quantity,
			totalCents: line.totalCents,
			options: (line.options ?? []).map((option) => ({
				optionName: option.optionName,
				quantity: option.quantity,
			})),
			instructions: line.instructions ?? null,
		})),
	}
}

function publicTabView(tab: QrTabRow, rounds: RestaurantOrder[]): QrPublicTab {
	return {
		id: tab.id,
		tabNumber: tab.tabNumber,
		status: tab.status,
		paymentStatus: tab.paymentStatus,
		table: {
			id: tab.tableId,
			label: tab.tableLabel,
			locationId: tab.locationId,
		},
		openedAt: new Date(tab.openedAt).toISOString(),
		closedAt: iso(tab.closedAt),
		rounds: rounds.map(roundView),
		totals: tabTotals(tab, rounds, { useSnapshot: true }),
		roundsPending: roundsPending(rounds),
	}
}

export type OperatorQrTab = QrPublicTab & {
	guestName: string | null
	guestPhone: string | null
	paymentMethod: 'counter' | 'online' | null
	voidReason: string | null
	lockedAt: string | null
	/** Online money received that did not settle the tab (needs review). */
	onlineAmountCents: number | null
	/** How many such payments arrived (each needs a refund or a note). */
	reviewPaymentCount: number
	version: number
}

type ReviewPayment = { tabId: string; amountCents: number }

async function listReviewPayments(
	db: Parameters<typeof listTabRounds>[0],
	tabIds: string[],
): Promise<Map<string, ReviewPayment[]>> {
	const byTab = new Map<string, ReviewPayment[]>()
	if (tabIds.length === 0) return byTab
	const rows = await db
		.select({
			tabId: qrTabPayments.tabId,
			amountCents: qrTabPayments.amountCents,
		})
		.from(qrTabPayments)
		// One JSON parameter: Durable Object SQLite caps bound values at 100.
		.where(inJsonList(qrTabPayments.tabId, tabIds))
	for (const row of rows) {
		const list = byTab.get(row.tabId) ?? []
		list.push(row)
		byTab.set(row.tabId, list)
	}
	return byTab
}

/** The operator view of one tab, with its rounds and review payments. */
async function loadOperatorView(
	db: Parameters<typeof listTabRounds>[0],
	tab: QrTabRow,
): Promise<OperatorQrTab> {
	const [rounds, payments] = await Promise.all([
		listTabRounds(db, [tab.id]),
		listReviewPayments(db, [tab.id]),
	])
	return operatorTabView(tab, rounds, payments.get(tab.id) ?? [])
}

function operatorTabView(
	tab: QrTabRow,
	rounds: RestaurantOrder[],
	reviewPayments: ReviewPayment[],
): OperatorQrTab {
	return {
		...publicTabView(tab, rounds),
		guestName: tab.guestName,
		guestPhone: tab.guestPhone,
		paymentMethod: tab.paymentMethod,
		voidReason: tab.voidReason,
		lockedAt: iso(tab.lockedAt),
		onlineAmountCents:
			reviewPayments.length > 0
				? reviewPayments.reduce((sum, payment) => sum + payment.amountCents, 0)
				: null,
		reviewPaymentCount: reviewPayments.length,
		version: tab.version,
	}
}

function tableView(
	orgId: string,
	table: QrTableRow,
	openTabId: string | null,
	withToken: boolean,
): QrTableView {
	return {
		id: table.id,
		locationId: table.locationId,
		label: table.label,
		tokenVersion: table.tokenVersion,
		token: withToken
			? deriveTableToken(orgId, table.id, table.tokenVersion)
			: null,
		importedRsvTableId: table.importedRsvTableId,
		archivedAt: iso(table.archivedAt),
		openTabId,
	}
}

// ---------------------------------------------------------------------------
// Public (guest) reads
// ---------------------------------------------------------------------------

export type TableContext = {
	table: { label: string; locationId: string }
	dineIn: {
		enabled: boolean
		requireGuestName: boolean
		requireGuestPhone: boolean
		onlineTabPayAvailable: boolean
	}
	openTab: {
		id: string
		tabToken: string
		tabNumber: string
		openedAt: string
		roundsCount: number
		totalCents: number
	} | null
}

/**
 * What a scanned table code unlocks on `GET /orders/options`. Flags off reads
 * as the same 404 as a disabled module; the policy says what checkout asks.
 */
export async function getTableContext(
	orgId: string,
	input: {
		capability: DineInCapability
		locationId: string
		context: RestaurantOrderContext
	},
): Promise<QrResult<TableContext>> {
	const features = readQrOrderingFeatures(
		(input.context as { qrOrdering?: unknown }).qrOrdering,
	)
	if (!features.dineIn) {
		return fail(
			404,
			'dine_in_unavailable',
			'Ordering at the table is not available.',
		)
	}
	const db = await getTenantDb(orgId)
	const resolved = await resolveDineIn(
		db,
		orgId,
		input.capability,
		input.locationId,
	)
	if (!resolved.ok) return resolved
	const settings = await readQrSettings(db)
	const location = input.context.menu.locations.find(
		(candidate) => candidate.id === input.locationId,
	)
	const tab = resolved.data.tab
	const rounds = tab ? await listTabRounds(db, [tab.id]) : []
	const totals = tab ? tabTotals(tab, rounds) : null
	return {
		ok: true,
		data: {
			table: {
				label: resolved.data.table.label,
				locationId: resolved.data.table.locationId,
			},
			dineIn: {
				enabled: Boolean(location?.fulfillmentOptions.dineIn),
				requireGuestName: settings.requireGuestName,
				requireGuestPhone: settings.requireGuestPhone,
				onlineTabPayAvailable:
					features.online &&
					settings.allowOnlineTabPay &&
					input.context.onlinePayment.enabled &&
					Boolean(input.context.onlinePayment.processor),
			},
			openTab: tab
				? {
						id: tab.id,
						tabToken: deriveTabToken(orgId, tab.id, tab.tabTokenVersion),
						tabNumber: tab.tabNumber,
						openedAt: new Date(tab.openedAt).toISOString(),
						roundsCount: rounds.length,
						totalCents: totals?.totalCents ?? 0,
					}
				: null,
		},
	}
}

/**
 * The tab behind a tab token: open tabs and settled ones alike (the guest's
 * receipt). A locked tab's old token reads as not found.
 */
export async function getPublicTab(
	orgId: string,
	tabToken: string,
): Promise<QrResult<QrPublicTab>> {
	const parsed = readTabToken(orgId, tabToken)
	const notFound = fail(
		404,
		'tab_not_found',
		'This tab is no longer available.',
	)
	if (!parsed) return notFound
	const db = await getTenantDb(orgId)
	const [tab] = await db
		.select()
		.from(qrTabs)
		.where(eq(qrTabs.id, parsed.id))
		.limit(1)
	if (!tab || tab.tabTokenVersion !== parsed.version) return notFound
	const rounds = await listTabRounds(db, [tab.id])
	return { ok: true, data: publicTabView(tab, rounds) }
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

async function openTabIdsByTable(
	db: Awaited<ReturnType<typeof getTenantDb>>,
	tableIds: string[],
) {
	const map = new Map<string, string>()
	if (tableIds.length === 0) return map
	const rows = await db
		.select({ id: qrTabs.id, tableId: qrTabs.tableId })
		.from(qrTabs)
		.where(eq(qrTabs.status, 'open'))
	for (const row of rows) map.set(row.tableId, row.id)
	return map
}

export async function listQrTables(
	orgId: string,
	options: {
		locationId?: string
		includeArchived?: boolean
		withTokens: boolean
	},
): Promise<QrTableView[]> {
	const db = await getTenantDb(orgId)
	const conditions = []
	if (options.locationId) {
		conditions.push(eq(qrTables.locationId, options.locationId))
	}
	if (!options.includeArchived) conditions.push(isNull(qrTables.archivedAt))
	const rows = await db
		.select()
		.from(qrTables)
		.where(conditions.length > 0 ? and(...conditions) : undefined)
		.orderBy(
			asc(qrTables.locationId),
			asc(qrTables.sortOrder),
			asc(qrTables.label),
		)
	const openTabs = await openTabIdsByTable(
		db,
		rows.map((row) => row.id),
	)
	return rows.map((row) =>
		tableView(orgId, row, openTabs.get(row.id) ?? null, options.withTokens),
	)
}

async function liveTableCount(
	tx: Parameters<Parameters<typeof runTenantTransaction>[1]>[0],
	locationId: string,
) {
	const rows = await tx
		.select({ id: qrTables.id })
		.from(qrTables)
		.where(
			and(eq(qrTables.locationId, locationId), isNull(qrTables.archivedAt)),
		)
	return rows.length
}

export async function createQrTables(
	orgId: string,
	input: { locationId: string; labels: string[] },
): Promise<QrResult<QrTableView[]>> {
	const labels = [...new Set(input.labels.map((label) => label.trim()))]
	return writeTx(orgId, async (tx) => {
		const existing = await liveTableCount(tx, input.locationId)
		if (existing + labels.length > QR_MAX_TABLES_PER_LOCATION) {
			return fail(
				422,
				'table_limit',
				`A location can have at most ${QR_MAX_TABLES_PER_LOCATION} tables.`,
			)
		}
		// Check every label first: a conflict halfway would otherwise keep the
		// tables inserted before it (the transaction commits on a return).
		const taken = await tx
			.select({ label: qrTables.label })
			.from(qrTables)
			.where(
				and(
					eq(qrTables.locationId, input.locationId),
					isNull(qrTables.archivedAt),
				),
			)
		const takenLabels = new Set(taken.map((row) => row.label))
		if (labels.some((label) => takenLabels.has(label))) {
			return fail(
				409,
				'table_label_taken',
				'A table with this label already exists at this location.',
			)
		}
		const now = Date.now()
		const created: QrTableRow[] = []
		for (const [index, label] of labels.entries()) {
			try {
				const [row] = await tx
					.insert(qrTables)
					.values({
						locationId: input.locationId,
						label,
						sortOrder: existing + index,
						createdAt: now,
						updatedAt: now,
					})
					.returning()
				if (row) created.push(row)
			} catch (error) {
				if (isUniqueConstraintError(error)) {
					return fail(
						409,
						'table_label_taken',
						'A table with this label already exists at this location.',
					)
				}
				throw error
			}
		}
		return {
			ok: true as const,
			data: created.map((row) => tableView(orgId, row, null, true)),
		}
	})
}

export async function patchQrTable(
	orgId: string,
	tableId: string,
	patch: { label?: string; archived?: boolean; regenerateToken?: true },
): Promise<QrResult<QrTableView>> {
	return writeTx(orgId, async (tx) => {
		const [table] = await tx
			.select()
			.from(qrTables)
			.where(eq(qrTables.id, tableId))
			.limit(1)
		if (!table) return fail(404, 'table_not_found', 'Table not found.')
		const [openTab] = await tx
			.select()
			.from(qrTabs)
			.where(and(eq(qrTabs.tableId, table.id), eq(qrTabs.status, 'open')))
			.limit(1)
		if (patch.archived === true && openTab) {
			return fail(
				409,
				'tab_open',
				'Close or void the open tab at this table before archiving it.',
			)
		}
		const set: Partial<typeof qrTables.$inferInsert> = { updatedAt: Date.now() }
		if (patch.label !== undefined) set.label = patch.label.trim()
		if (patch.archived !== undefined) {
			set.archivedAt = patch.archived ? Date.now() : null
		}
		if (patch.regenerateToken) {
			set.tokenVersion = table.tokenVersion + 1
			if (openTab) {
				// A copied card may already have joined the open tab: burn the
				// tab code too (guests re-scan the new card to rejoin) and drop
				// a pay request nobody has bound yet.
				await tx
					.update(qrTabs)
					.set({
						tabTokenVersion: openTab.tabTokenVersion + 1,
						...(openTab.paymentStatus === 'unpaid' ? UNBIND : {}),
						version: openTab.version + 1,
						updatedAt: Date.now(),
					})
					.where(eq(qrTabs.id, openTab.id))
			}
		}
		try {
			const [updated] = await tx
				.update(qrTables)
				.set(set)
				.where(eq(qrTables.id, table.id))
				.returning()
			return {
				ok: true as const,
				data: tableView(orgId, updated ?? table, openTab?.id ?? null, true),
			}
		} catch (error) {
			if (isUniqueConstraintError(error)) {
				return fail(
					409,
					'table_label_taken',
					'A table with this label already exists at this location.',
				)
			}
			throw error
		}
	})
}

export type FloorPlanImportResult = {
	created: number
	updated: number
	linked: number
	archived: number
}

/**
 * Imports (and re-syncs) the reservations floor plan of one location: a
 * floor-plan table becomes a QR table, a manual QR table with the same label
 * is linked instead of duplicated, a renamed floor-plan table renames its QR
 * table, and a QR table whose floor-plan table was archived is archived too
 * (unless a tab is open there). Tokens never change, so prints keep working.
 */
export async function importFloorPlan(
	orgId: string,
	locationId: string,
): Promise<QrResult<FloorPlanImportResult>> {
	return writeTx(orgId, async (tx) => {
		const floor = await tx
			.select({
				id: rsvTables.id,
				label: rsvTables.label,
				priority: rsvTables.priority,
			})
			.from(rsvTables)
			.where(
				and(eq(rsvTables.locationId, locationId), isNull(rsvTables.archivedAt)),
			)
			.orderBy(asc(rsvTables.label))
		const live = await tx
			.select()
			.from(qrTables)
			.where(
				and(eq(qrTables.locationId, locationId), isNull(qrTables.archivedAt)),
			)
		const byImported = new Map(
			live
				.filter((table) => table.importedRsvTableId)
				.map((table) => [table.importedRsvTableId!, table]),
		)
		const byLabel = new Map(live.map((table) => [table.label, table]))
		const floorIds = new Set(floor.map((table) => table.id))
		const result: FloorPlanImportResult = {
			created: 0,
			updated: 0,
			linked: 0,
			archived: 0,
		}
		const now = Date.now()

		const openTabTables = new Set(
			(
				await tx
					.select({ tableId: qrTabs.tableId })
					.from(qrTabs)
					.where(eq(qrTabs.status, 'open'))
			).map((row) => row.tableId),
		)
		for (const table of live) {
			if (
				table.importedRsvTableId &&
				!floorIds.has(table.importedRsvTableId) &&
				!openTabTables.has(table.id)
			) {
				await tx
					.update(qrTables)
					.set({ archivedAt: now, updatedAt: now })
					.where(eq(qrTables.id, table.id))
				byLabel.delete(table.label)
				result.archived += 1
			}
		}

		let sortOrder = live.length
		for (const source of floor) {
			const imported = byImported.get(source.id)
			if (imported) {
				if (imported.label !== source.label && !byLabel.has(source.label)) {
					await tx
						.update(qrTables)
						.set({ label: source.label, updatedAt: now })
						.where(eq(qrTables.id, imported.id))
					byLabel.delete(imported.label)
					byLabel.set(source.label, { ...imported, label: source.label })
					result.updated += 1
				}
				continue
			}
			const sameLabel = byLabel.get(source.label)
			if (sameLabel) {
				if (!sameLabel.importedRsvTableId) {
					await tx
						.update(qrTables)
						.set({ importedRsvTableId: source.id, updatedAt: now })
						.where(eq(qrTables.id, sameLabel.id))
					result.linked += 1
				}
				continue
			}
			if (byLabel.size >= QR_MAX_TABLES_PER_LOCATION) break
			const [row] = await tx
				.insert(qrTables)
				.values({
					locationId,
					label: source.label,
					importedRsvTableId: source.id,
					sortOrder: sortOrder++,
					createdAt: now,
					updatedAt: now,
				})
				.returning()
			if (row) byLabel.set(row.label, row)
			result.created += 1
		}
		return { ok: true as const, data: result }
	})
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getQrSettings(orgId: string): Promise<QrSettingsView> {
	return readQrSettings(await getTenantDb(orgId))
}

export async function patchQrSettings(
	orgId: string,
	patch: QrSettingsPatch,
): Promise<QrSettingsView> {
	return writeTx(orgId, async (tx) => {
		const current = await readQrSettings(tx)
		const next = { ...current, ...patch }
		await tx
			.insert(qrSettings)
			.values({ id: 'default', ...next, updatedAt: Date.now() })
			.onConflictDoUpdate({
				target: qrSettings.id,
				set: { ...next, updatedAt: Date.now() },
			})
		return next
	})
}

// ---------------------------------------------------------------------------
// Tabs (operator)
// ---------------------------------------------------------------------------

/** Extra online money on a closed or voided tab stays listed this long. */
const QR_REVIEW_LIST_MS = 14 * 24 * 60 * 60 * 1000

/**
 * Closed or voided tabs that received online money after (or besides) their
 * settlement in the last 14 days: staff refund or keep it in the payment
 * dashboard. Open tabs show it on their own card.
 */
async function listSettledTabsWithReview(
	db: Awaited<ReturnType<typeof getTenantDb>>,
	limit: number,
): Promise<QrTabRow[]> {
	const recent = await db
		.selectDistinct({ tabId: qrTabPayments.tabId })
		.from(qrTabPayments)
		.where(gt(qrTabPayments.receivedAt, Date.now() - QR_REVIEW_LIST_MS))
		.orderBy(desc(qrTabPayments.tabId))
		.limit(limit)
	if (recent.length === 0) return []
	return db
		.select()
		.from(qrTabs)
		.where(
			and(
				inJsonList(
					qrTabs.id,
					recent.map((row) => row.tabId),
				),
				ne(qrTabs.status, 'open'),
			),
		)
		.orderBy(desc(qrTabs.closedAt))
}

export async function listOperatorTabs(
	orgId: string,
	options: { status: QrTabStatus | 'recent' | 'review'; limit: number },
): Promise<OperatorQrTab[]> {
	const db = await getTenantDb(orgId)
	const tabs =
		options.status === 'review'
			? await listSettledTabsWithReview(db, options.limit)
			: options.status === 'recent'
				? await db
						.select()
						.from(qrTabs)
						.orderBy(desc(qrTabs.openedAt))
						.limit(options.limit)
				: await db
						.select()
						.from(qrTabs)
						.where(eq(qrTabs.status, options.status))
						.orderBy(desc(qrTabs.openedAt))
						.limit(options.limit)
	const rounds = await listTabRounds(
		db,
		tabs.map((tab) => tab.id),
	)
	const byTab = new Map<string, RestaurantOrder[]>()
	for (const round of rounds) {
		if (!round.tabId) continue
		const list = byTab.get(round.tabId) ?? []
		list.push(round)
		byTab.set(round.tabId, list)
	}
	const payments = await listReviewPayments(
		db,
		tabs.map((tab) => tab.id),
	)
	return tabs.map((tab) =>
		operatorTabView(tab, byTab.get(tab.id) ?? [], payments.get(tab.id) ?? []),
	)
}

export async function getOperatorTab(
	orgId: string,
	tabId: string,
): Promise<QrResult<OperatorQrTab>> {
	const db = await getTenantDb(orgId)
	const [tab] = await db
		.select()
		.from(qrTabs)
		.where(eq(qrTabs.id, tabId))
		.limit(1)
	if (!tab) return fail(404, 'tab_not_found', 'Tab not found.')
	return {
		ok: true,
		data: await loadOperatorView(db, tab),
	}
}

function releasedSessionOf(tab: QrTabRow) {
	return tab.paymentSessionId && tab.paymentProcessor
		? { sessionId: tab.paymentSessionId, processor: tab.paymentProcessor }
		: null
}

/** Clears a tab's online payment binding (not its review rows). */
const UNBIND = {
	paymentSessionId: null,
	paymentProcessor: null,
	paymentAmountCents: null,
	paymentTipCents: null,
	paymentTokenHash: null,
} as const

async function loadOpenTab(
	tx: Parameters<Parameters<typeof runTenantTransaction>[1]>[0],
	tabId: string,
	options: { acknowledgeReview?: boolean; expectedTotalCents?: number } = {},
): Promise<QrResult<QrTabRow>> {
	const [tab] = await tx
		.select()
		.from(qrTabs)
		.where(eq(qrTabs.id, tabId))
		.limit(1)
	if (!tab) return fail(404, 'tab_not_found', 'Tab not found.')
	if (tab.status !== 'open') {
		return fail(409, 'tab_closed', 'This tab is already closed.')
	}
	if (tab.paymentStatus === 'pending' && isTabPaymentOpen(tab, new Date())) {
		return fail(
			409,
			'payment_pending',
			'The guest is paying this tab online. Wait a moment and refresh, or stop the online payment.',
		)
	}
	if (tab.paymentStatus === 'review' && !options.acknowledgeReview) {
		// Money already arrived online: staff must look before charging again.
		return fail(
			409,
			'payment_review',
			'This tab was paid online. Check the payment before you close it.',
		)
	}
	if (options.expectedTotalCents !== undefined) {
		// Staff confirm what they saw: a round that landed after the dialog
		// opened must never be marked paid (or cancelled) unseen.
		const rounds = await listTabRounds(tx, [tab.id])
		if (tabTotals(tab, rounds).totalCents !== options.expectedTotalCents) {
			return fail(
				409,
				'stale_tab',
				'This tab changed since you opened it. Check the new total.',
			)
		}
	}
	return { ok: true, data: tab }
}

/**
 * Counter close: the operator took the money. Every round that still counts
 * is marked paid and the totals are snapshotted on the tab. Pending kitchen
 * work does not block a counter close (operator judgment).
 */
export async function closeTabAtCounter(
	orgId: string,
	tabId: string,
	input: {
		tipCents?: number
		closedBy: string
		acknowledgeReview?: boolean
		expectedTotalCents?: number
	},
): Promise<QrResult<ReleasedTabPayment>> {
	return writeTx(orgId, async (tx) => {
		const loaded = await loadOpenTab(tx, tabId, {
			acknowledgeReview: input.acknowledgeReview,
			expectedTotalCents: input.expectedTotalCents,
		})
		if (!loaded.ok) return loaded
		const tab = loaded.data
		const rounds = await listTabRounds(tx, [tab.id])
		const totals: QrTabTotals = tabTotals(tab, rounds)
		const tipCents = input.tipCents ?? 0
		const now = new Date()
		await markTabRoundsPaid(tx, tab.id, now)
		const [updated] = await tx
			.update(qrTabs)
			.set({
				status: 'closed',
				paymentMethod: 'counter',
				// An online payment under review stays flagged: it still needs a
				// refund or a note, and must never be overwritten.
				paymentStatus: tab.paymentStatus === 'review' ? 'review' : 'paid',
				// Paid at the counter: drop any online binding, so money that still
				// arrives on an old payment page is kept for review, never taken
				// for a replay of a payment that settled this tab.
				...UNBIND,
				subtotalCents: totals.subtotalCents,
				taxCents: totals.taxCents,
				tipCents,
				totalCents: totals.totalCents + tipCents,
				closedBy: input.closedBy,
				closedAt: now.getTime(),
				paidAt: now.getTime(),
				version: tab.version + 1,
				updatedAt: now.getTime(),
			})
			.where(eq(qrTabs.id, tab.id))
			.returning()
		return {
			ok: true as const,
			data: {
				tab: await loadOperatorView(tx, updated ?? tab),
				// The page this close or void unbound, for the App to expire.
				releasedSession: releasedSessionOf(tab),
			},
		}
	})
}

/**
 * Void: nothing is charged. Rounds the kitchen has not finished are
 * cancelled; served rounds stay on record. The reason is kept on the tab.
 */
export async function voidTab(
	orgId: string,
	tabId: string,
	input: {
		reason: string
		closedBy: string
		acknowledgeReview?: boolean
		expectedTotalCents?: number
	},
): Promise<QrResult<ReleasedTabPayment>> {
	return writeTx(orgId, async (tx) => {
		const loaded = await loadOpenTab(tx, tabId, {
			acknowledgeReview: input.acknowledgeReview,
			expectedTotalCents: input.expectedTotalCents,
		})
		if (!loaded.ok) return loaded
		const tab = loaded.data
		const now = new Date()
		await tx
			.update(restaurantOrders)
			.set({ status: 'cancelled', cancelledAt: now, updatedAt: now })
			.where(
				and(
					eq(restaurantOrders.tabId, tab.id),
					inArray(restaurantOrders.status, [...QR_ROUND_PENDING_STATUSES]),
				),
			)
		const [updated] = await tx
			.update(qrTabs)
			.set({
				status: 'cancelled',
				voidReason: input.reason,
				...UNBIND,
				closedBy: input.closedBy,
				closedAt: now.getTime(),
				version: tab.version + 1,
				updatedAt: now.getTime(),
			})
			.where(eq(qrTabs.id, tab.id))
			.returning()
		return {
			ok: true as const,
			data: {
				tab: await loadOperatorView(tx, updated ?? tab),
				// The page this close or void unbound, for the App to expire.
				releasedSession: releasedSessionOf(tab),
			},
		}
	})
}

/**
 * Staff stop an online payment that is stuck (a closed payment page, a
 * provider that never reports): the session is unbound and the tab can be
 * closed at the counter. Money that still arrives for it is kept for review.
 */
export type ReleasedTabPayment = {
	tab: OperatorQrTab
	/**
	 * The hosted session that was bound, so the App can expire it at the
	 * provider (Stripe). Checkout.com pages cannot be expired: money that still
	 * arrives there is kept for review.
	 */
	releasedSession: { sessionId: string; processor: string } | null
}

export async function releaseTabPayment(
	orgId: string,
	tabId: string,
): Promise<QrResult<ReleasedTabPayment>> {
	return writeTx(orgId, async (tx) => {
		const [tab] = await tx
			.select()
			.from(qrTabs)
			.where(eq(qrTabs.id, tabId))
			.limit(1)
		if (!tab) return fail(404, 'tab_not_found', 'Tab not found.')
		if (tab.status !== 'open') {
			return fail(409, 'tab_closed', 'This tab is already closed.')
		}
		if (tab.paymentStatus === 'paid' || tab.paymentStatus === 'review') {
			return fail(
				409,
				'payment_review',
				'This tab was paid online. Check the payment.',
			)
		}
		const now = Date.now()
		const [updated] = await tx
			.update(qrTabs)
			.set({
				paymentStatus: 'unpaid',
				paymentSessionId: null,
				paymentProcessor: null,
				paymentAmountCents: null,
				paymentTipCents: null,
				paymentTokenHash: null,
				paymentEventAt: now,
				version: tab.version + 1,
				updatedAt: now,
			})
			.where(eq(qrTabs.id, tab.id))
			.returning()
		return {
			ok: true as const,
			data: {
				tab: await loadOperatorView(tx, updated ?? tab),
				releasedSession: releasedSessionOf(tab),
			},
		}
	})
}

/**
 * Lock: burns the guests' tab token and keeps the tab shut to every phone
 * (a re-scan of the table code is refused too), so staff can settle it. Only
 * a close or a void ends it; the table code then opens a new tab.
 */
export async function lockTab(
	orgId: string,
	tabId: string,
): Promise<QrResult<OperatorQrTab>> {
	return writeTx(orgId, async (tx) => {
		const [tab] = await tx
			.select()
			.from(qrTabs)
			.where(eq(qrTabs.id, tabId))
			.limit(1)
		if (!tab) return fail(404, 'tab_not_found', 'Tab not found.')
		if (tab.status !== 'open') {
			return fail(409, 'tab_closed', 'This tab is already closed.')
		}
		const now = Date.now()
		const [updated] = await tx
			.update(qrTabs)
			.set({
				tabTokenVersion: tab.tabTokenVersion + 1,
				lockedAt: tab.lockedAt ?? now,
				// A pay request that has not reached the provider dies with the lock.
				...(tab.paymentStatus === 'unpaid'
					? {
							paymentAmountCents: null,
							paymentTipCents: null,
							paymentTokenHash: null,
						}
					: {}),
				version: tab.version + 1,
				updatedAt: now,
			})
			.where(eq(qrTabs.id, tab.id))
			.returning()
		return {
			ok: true as const,
			data: await loadOperatorView(tx, updated ?? tab),
		}
	})
}

// ---------------------------------------------------------------------------
// Paying from the phone (online close). The App bridge sees the tab as the
// order `tab:<id>`; amounts and state stay here.
// ---------------------------------------------------------------------------

function sha256Hex(value: string) {
	return crypto.createHash('sha256').update(value).digest('hex')
}

export type TabPayIntent = {
	orderRef: string
	tabPaymentToken: string
	amountCents: number
	tipCents: number
	currency: string
}

/**
 * The guest asks to pay: the venue must allow it, every round must have left
 * the kitchen's queue, and name and phone are required. The tip is a share of
 * the subtotal. While a payment session is bound the amount is frozen.
 */
export async function prepareTabPayment(
	orgId: string,
	tabToken: string,
	input: {
		tipPercent: number
		contact: { name: string; phone: string }
		features: { online: boolean }
		onlinePayment: { enabled: boolean; processor: string | null }
	},
): Promise<QrResult<TabPayIntent>> {
	const parsed = readTabToken(orgId, tabToken)
	if (!parsed)
		return fail(404, 'tab_not_found', 'This tab is no longer available.')
	if (
		!input.features.online ||
		!input.onlinePayment.enabled ||
		!input.onlinePayment.processor
	) {
		return fail(
			409,
			'online_pay_unavailable',
			'Paying from the phone is not available. Please pay at the counter.',
		)
	}
	return writeTx(orgId, async (tx) => {
		const [tab] = await tx
			.select()
			.from(qrTabs)
			.where(eq(qrTabs.id, parsed.id))
			.limit(1)
		if (!tab || tab.tabTokenVersion !== parsed.version) {
			return fail(404, 'tab_not_found', 'This tab is no longer available.')
		}
		if (tab.status !== 'open')
			return fail(409, 'tab_closed', 'This tab is already closed.')
		if (tab.lockedAt != null) {
			return fail(
				423,
				'tab_locked',
				'A team member is settling this tab. Please ask them for help.',
			)
		}
		const settings = await readQrSettings(tx)
		if (!settings.allowOnlineTabPay) {
			return fail(
				409,
				'online_pay_unavailable',
				'Paying from the phone is not available. Please pay at the counter.',
			)
		}
		const rounds = await listTabRounds(tx, [tab.id])
		if (roundsPending(rounds)) {
			return fail(
				409,
				'rounds_pending',
				'Part of your order is still being prepared. You can pay once it has been served.',
			)
		}
		const totals = tabTotals(tab, rounds)
		if (totals.totalCents <= 0) {
			return fail(409, 'tab_empty', 'There is nothing to pay on this tab yet.')
		}
		const tabPaymentToken = deriveTabPaymentToken(orgId, tab.id)
		const now = new Date()
		const holdOpen = isTabPaymentOpen(tab, now)
		if (
			tab.paymentStatus === 'pending' &&
			tab.paymentSessionId &&
			tab.paymentAmountCents != null &&
			holdOpen
		) {
			// A session is live. Re-serve it only to someone asking for the same
			// payment; a different tip means another guest is paying right now.
			const askedTip = Math.round(
				(totals.subtotalCents * input.tipPercent) / 100,
			)
			if (askedTip !== (tab.paymentTipCents ?? 0)) {
				return fail(
					409,
					'tab_paying',
					'Someone at the table is paying this tab right now. Please wait a moment.',
				)
			}
			return {
				ok: true as const,
				data: {
					orderRef: tabOrderRef(tab.id),
					tabPaymentToken,
					amountCents: tab.paymentAmountCents,
					tipCents: tab.paymentTipCents ?? 0,
					currency: tab.currency,
				},
			}
		}
		if (tab.paymentStatus === 'paid' || tab.paymentStatus === 'review') {
			return fail(409, 'tab_closed', 'This tab is already paid.')
		}
		const tipCents = Math.round((totals.subtotalCents * input.tipPercent) / 100)
		const amountCents = totals.totalCents + tipCents
		// The freeze runs from the first ask: a re-ask (or a different tip)
		// re-prices the payment but never restarts it, so nobody can keep the
		// table frozen by asking again and again.
		const sameRequest =
			holdOpen &&
			tab.paymentStatus === 'unpaid' &&
			tab.paymentAmountCents != null
		await tx
			.update(qrTabs)
			.set({
				// The guest who opened the tab keeps their details on it.
				guestName: tab.guestName ?? input.contact.name,
				guestPhone: tab.guestPhone ?? input.contact.phone,
				// A lapsed binding (a payment page abandoned past the hold, e.g.
				// Checkout.com, which never reports expiry) is forgotten here.
				paymentStatus: 'unpaid',
				paymentSessionId: null,
				paymentProcessor: null,
				paymentTipCents: tipCents,
				paymentEventAt: sameRequest
					? (tab.paymentEventAt ?? now.getTime())
					: now.getTime(),
				paymentAmountCents: amountCents,
				paymentTokenHash: sha256Hex(tabPaymentToken),
				updatedAt: now.getTime(),
			})
			.where(eq(qrTabs.id, tab.id))
		return {
			ok: true as const,
			data: {
				orderRef: tabOrderRef(tab.id),
				tabPaymentToken,
				amountCents,
				tipCents,
				currency: tab.currency,
			},
		}
	})
}

async function loadPayableTab(
	db:
		| Parameters<Parameters<typeof runTenantTransaction>[1]>[0]
		| Awaited<ReturnType<typeof getTenantDb>>,
	tabId: string,
) {
	const [tab] = await db
		.select()
		.from(qrTabs)
		.where(eq(qrTabs.id, tabId))
		.limit(1)
	return tab ?? null
}

/**
 * What the tab costs right now (rounds that count, plus the tip fixed at the
 * pay request). Every bridge step compares it with the stored amount, so a
 * round added after the pay request can never be settled by an older payment.
 */
async function currentPayableCents(
	db: Parameters<typeof loadPayableTab>[0],
	tab: QrTabRow,
): Promise<number> {
	const rounds = await listTabRounds(db, [tab.id])
	return tabTotals(tab, rounds).totalCents + (tab.paymentTipCents ?? 0)
}

/** Hosted session lifetime for a tab: Stripe's 30-minute minimum plus room. */
const QR_TAB_HOSTED_SESSION_MS = 40 * 60 * 1000

/** `POST /api/orders/quote` for `tab:<id>`: amounts and state only. */
export async function getTabQuote(
	orgId: string,
	tabId: string,
	paymentToken: string,
) {
	const db = await getTenantDb(orgId)
	const tab = await loadPayableTab(db, tabId)
	if (!tab || !tab.paymentTokenHash) {
		return fail(404, 'order_not_found', 'Order not found.')
	}
	if (!timingSafeEqualString(sha256Hex(paymentToken), tab.paymentTokenHash)) {
		return fail(403, 'invalid_payment_token', 'This payment link is not valid.')
	}
	if (tab.paymentAmountCents == null) {
		return fail(409, 'not_online_order', 'This tab has no payment in progress.')
	}
	if (
		tab.status === 'open' &&
		tab.paymentStatus === 'unpaid' &&
		(tab.lockedAt != null || !(await readQrSettings(db)).allowOnlineTabPay)
	) {
		return fail(
			409,
			'online_pay_unavailable',
			'Paying from the phone is not available. Please pay at the counter.',
		)
	}
	if (
		tab.status === 'open' &&
		tab.paymentStatus !== 'paid' &&
		(await currentPayableCents(db, tab)) !== tab.paymentAmountCents
	) {
		return fail(
			409,
			'amount_changed',
			'The tab changed. Start the payment again.',
		)
	}
	return {
		ok: true as const,
		data: {
			orgId,
			orderId: tabOrderRef(tab.id),
			totalCents: tab.paymentAmountCents,
			currency: tab.currency,
			// Bounds the provider session (about 40 minutes), so a payment page
			// left open cannot hold the table for a day.
			holdExpiresAt:
				tab.paymentEventAt != null
					? new Date(
							tab.paymentEventAt + QR_TAB_HOSTED_SESSION_MS,
						).toISOString()
					: null,
			status: tab.status === 'open' ? 'accepted' : tab.status,
			paymentStatus:
				tab.paymentStatus === 'paid' || tab.paymentStatus === 'review'
					? 'paid'
					: tab.paymentStatus === 'pending'
						? 'pending'
						: 'pending',
			...(tab.paymentSessionId && tab.paymentProcessor
				? { sessionId: tab.paymentSessionId, processor: tab.paymentProcessor }
				: {}),
		},
	}
}

/** Binds one provider session to the tab, exactly once. */
export async function bindTabPaymentSession(input: {
	orgId: string
	tabId: string
	sessionId: string
	processor: 'connect' | 'checkout'
}) {
	return writeTx(input.orgId, async (tx) => {
		const tab = await loadPayableTab(tx, input.tabId)
		if (!tab || tab.paymentAmountCents == null) {
			return fail(404, 'order_not_found', 'Order not found.')
		}
		if (
			tab.status !== 'open' ||
			tab.paymentStatus === 'paid' ||
			tab.paymentStatus === 'review'
		) {
			return fail(
				409,
				'payment_terminal',
				'This tab already has a terminal payment state.',
			)
		}
		if (tab.paymentSessionId && tab.paymentSessionId !== input.sessionId) {
			return fail(
				409,
				'session_conflict',
				'This tab already has a bound payment session.',
			)
		}
		if (tab.lockedAt != null || !(await readQrSettings(tx)).allowOnlineTabPay) {
			return fail(
				409,
				'online_pay_unavailable',
				'Paying from the phone is not available. Please pay at the counter.',
			)
		}
		if ((await currentPayableCents(tx, tab)) !== tab.paymentAmountCents) {
			return fail(
				409,
				'amount_changed',
				'The tab changed. Start the payment again.',
			)
		}
		if (tab.paymentSessionId !== input.sessionId) {
			await tx
				.update(qrTabs)
				.set({
					paymentSessionId: input.sessionId,
					paymentProcessor: input.processor,
					paymentStatus: 'pending',
					paymentEventAt: Date.now(),
					updatedAt: Date.now(),
				})
				.where(eq(qrTabs.id, tab.id))
		}
		return {
			ok: true as const,
			data: {
				orgId: input.orgId,
				orderId: tabOrderRef(tab.id),
				sessionId: input.sessionId,
				status: 'accepted',
				paymentStatus: 'pending',
			},
		}
	})
}

/**
 * A verified payment event for a tab. Paid closes the tab and settles every
 * counting round; a payment that lands on a tab staff already closed or
 * voided is kept as `review` for manual handling (runbook). Failed or
 * expired sessions unbind, so the guest can try again or pay at the counter.
 */
export async function applyTabPaymentEvent(input: {
	orgId: string
	tabId: string
	sessionId: string
	processor: 'connect' | 'checkout'
	status: 'paid' | 'failed' | 'expired'
	amountCents: number
	currency: string
	/** One payment's provider id, when the session id is shared (Checkout.com). */
	paymentId?: string
}) {
	return writeTx(input.orgId, async (tx) => {
		const tab = await loadPayableTab(tx, input.tabId)
		if (!tab) return fail(404, 'order_not_found', 'Order not found.')
		if (
			tab.paymentStatus === 'paid' &&
			(input.status !== 'paid' ||
				(tab.paymentMethod === 'online' &&
					tab.paymentProcessor === input.processor &&
					tab.paymentSessionId === (input.paymentId ?? input.sessionId)))
		) {
			// A redelivered event for the payment that settled this tab online,
			// or a failed or expired page on a settled tab: nothing to change.
			return {
				ok: true as const,
				data: {
					orgId: input.orgId,
					orderId: tabOrderRef(tab.id),
					sessionId: input.sessionId,
					status: tab.status,
					paymentStatus: 'paid',
				},
			}
		}
		const matches =
			tab.paymentSessionId === input.sessionId &&
			tab.paymentProcessor === input.processor &&
			tab.paymentAmountCents === input.amountCents &&
			tab.currency.toLowerCase() === input.currency.toLowerCase()
		const result = (paymentStatus: string) => ({
			ok: true as const,
			data: {
				orgId: input.orgId,
				orderId: tabOrderRef(tab.id),
				sessionId: input.sessionId,
				status: tab.status,
				paymentStatus,
			},
		})
		const now = new Date()
		/**
		 * Money that does not settle the tab (a stopped or replaced session, a
		 * re-priced tab, a tab already settled): one append-only row per
		 * payment, so a second one never hides the first. The live binding is
		 * left alone; the tab is flagged for a person to refund or keep.
		 */
		const keepForReview = async () => {
			const inserted = await tx
				.insert(qrTabPayments)
				.values({
					id: crypto.randomUUID(),
					tabId: tab.id,
					// Checkout.com binds one reference per tab, so its payment id is
					// what tells a second payment from a redelivered event.
					sessionId: input.paymentId ?? input.sessionId,
					processor: input.processor,
					amountCents: input.amountCents,
					currency: input.currency.toUpperCase(),
					receivedAt: now.getTime(),
				})
				.onConflictDoNothing()
				.returning({ id: qrTabPayments.id })
			// The row is the record. An unsettled tab is flagged so staff must
			// look before charging; a settled one keeps its own settlement
			// (status and time) and shows the extra money through its rows.
			if (inserted.length > 0 && tab.paymentStatus !== 'paid') {
				await tx
					.update(qrTabs)
					.set({
						paymentStatus: 'review',
						paymentEventAt: now.getTime(),
						updatedAt: now.getTime(),
					})
					.where(eq(qrTabs.id, tab.id))
			}
			// Kept (now or by an earlier delivery of the same payment).
			return result('review')
		}
		if (!matches) {
			if (input.status === 'paid') return keepForReview()
			// An expired or failed event for the session that is bound right now
			// unbinds it even if the tab was re-priced meanwhile.
			if (
				tab.paymentSessionId !== input.sessionId ||
				tab.paymentProcessor !== input.processor
			) {
				return fail(
					403,
					'session_mismatch',
					'This payment event does not match the bound payment session.',
				)
			}
		}
		if (input.status === 'paid') {
			// Settled already (a replay of the settling payment returned above):
			// this is more money, kept for review.
			if (tab.paymentStatus === 'paid') return keepForReview()
			// Settled elsewhere meanwhile, under review already, or the tab no
			// longer costs what was paid: keep the money for a person to look
			// at, never close blind.
			if (
				tab.status !== 'open' ||
				tab.paymentStatus === 'review' ||
				(await currentPayableCents(tx, tab)) !== input.amountCents
			) {
				return keepForReview()
			}
			const rounds = await listTabRounds(tx, [tab.id])
			const totals = tabTotals(tab, rounds)
			const tipCents = tab.paymentTipCents ?? 0
			await markTabRoundsPaid(tx, tab.id, now)
			await tx
				.update(qrTabs)
				.set({
					status: 'closed',
					paymentMethod: 'online',
					paymentStatus: 'paid',
					// The settling payment itself, so only its exact replay is
					// treated as one (Checkout.com shares the session per tab).
					paymentSessionId: input.paymentId ?? input.sessionId,
					subtotalCents: totals.subtotalCents,
					taxCents: totals.taxCents,
					tipCents,
					totalCents: input.amountCents,
					closedBy: 'guest',
					closedAt: now.getTime(),
					paidAt: now.getTime(),
					paymentEventAt: now.getTime(),
					version: tab.version + 1,
					updatedAt: now.getTime(),
				})
				.where(eq(qrTabs.id, tab.id))
			return result('paid')
		}
		if (tab.paymentStatus === 'paid' || tab.paymentStatus === 'review') {
			return result(tab.paymentStatus)
		}
		if (input.status === 'failed' && input.processor === 'checkout') {
			// A declined card on a Checkout.com page can be retried on the same
			// page: keep the binding (and the frozen amount) until it expires.
			return result('pending')
		}
		await tx
			.update(qrTabs)
			.set({
				paymentStatus: 'unpaid',
				paymentSessionId: null,
				paymentProcessor: null,
				paymentAmountCents: null,
				paymentTipCents: null,
				paymentEventAt: now.getTime(),
				updatedAt: now.getTime(),
			})
			.where(eq(qrTabs.id, tab.id))
		return result(input.status === 'failed' ? 'failed' : 'expired')
	})
}
