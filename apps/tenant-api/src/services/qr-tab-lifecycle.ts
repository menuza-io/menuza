import { and, eq, sql } from 'drizzle-orm'
import { splitEqualCents } from '@repo/common/pos-split-check'
import {
	qrSettings,
	qrTabEvents,
	qrTabPayments,
	qrTabs,
	restaurantOrders,
	type TenantDatabase,
} from '@repo/tenant-db'

const HOUR_MS = 60 * 60 * 1000

export type TabChargeResult =
	| { ok: true; sessionId: string; processor: string }
	| { ok: false }

/**
 * Closes open tabs that have been idle longer than the location's setting.
 * A tab with a payment in progress is skipped. A held card is charged through
 * `charge` (tests pass a mock). Otherwise the tab is flagged for a manager.
 * Nothing here opens a new cron.
 */
export async function closeForgottenTabs(
	db: TenantDatabase,
	options: {
		now?: number
		charge?: (input: {
			tabId: string
			amountCents: number
			heldPaymentRef: string
		}) => Promise<TabChargeResult>
		notify?: (input: { tabId: string; locationId: string }) => Promise<void>
	} = {},
): Promise<{ closed: number; skipped: number; flagged: number }> {
	const now = options.now ?? Date.now()
	const [settings] = await db.select().from(qrSettings).limit(1)
	const hours = settings?.autoCloseHours ?? 0
	if (hours <= 0) return { closed: 0, skipped: 0, flagged: 0 }
	const open = await db
		.select()
		.from(qrTabs)
		.where(eq(qrTabs.status, 'open'))
	let closed = 0
	let skipped = 0
	let flagged = 0
	for (const tab of open) {
		if (tab.paymentStatus === 'pending' || tab.paymentSessionId) {
			skipped += 1
			continue
		}
		const [round] = await db
			.select({
				at: sql<number | null>`max(${restaurantOrders.createdAt})`,
			})
			.from(restaurantOrders)
			.where(eq(restaurantOrders.tabId, tab.id))
		const last = toMs(round?.at) ?? tab.lastRoundAt ?? tab.openedAt
		if (now - last < hours * HOUR_MS) continue
		const actor = 'auto'
		let paid = false
		if (tab.heldPaymentRef && options.charge) {
			const charge = await options.charge({
				tabId: tab.id,
				amountCents: tab.totalCents,
				heldPaymentRef: tab.heldPaymentRef,
			})
			if (charge.ok) {
				await db.insert(qrTabPayments).values({
					id: `auto-${tab.id}`,
					tabId: tab.id,
					sessionId: charge.sessionId,
					processor: charge.processor,
					amountCents: tab.totalCents,
					currency: tab.currency,
					receivedAt: now,
					splitStatus: null,
				})
				paid = true
			}
		}
		await db
			.update(qrTabs)
			.set({
				status: 'closed',
				closedAt: now,
				closedBy: actor,
				closedByActor: actor,
				paymentStatus: paid ? 'paid' : tab.paymentStatus,
				paidAt: paid ? now : tab.paidAt,
				managerFlaggedAt: paid ? null : now,
				updatedAt: now,
				version: tab.version + 1,
			})
			.where(and(eq(qrTabs.id, tab.id), eq(qrTabs.status, 'open')))
		await db.insert(qrTabEvents).values({
			tabId: tab.id,
			kind: 'closed',
			actor,
			detail: paid ? 'charged' : 'flagged',
			createdAt: now,
		})
		if (!paid) {
			flagged += 1
			await options.notify?.({ tabId: tab.id, locationId: tab.locationId })
		}
		closed += 1
	}
	return { closed, skipped, flagged }
}

function toMs(value: number | Date | null | undefined): number | null {
	if (value == null) return null
	if (value instanceof Date) return value.getTime()
	const n = Number(value)
	return Number.isFinite(n) && n > 0 ? n : null
}

export type SplitPayInput = {
	tabId: string
	/** Pay this share. Omit to pay the next unpaid equal share of `parts`. */
	amountCents?: number
	parts?: number
	sessionId: string
	processor?: string
	/** A failed charge is recorded and does not close the tab. */
	ok?: boolean
	now?: number
}

/**
 * Records one guest's share of a tab (#389). The tab stays open until the
 * succeeded shares cover the total. Rounding leftover is on the last share.
 */
export async function payTabSplit(
	db: TenantDatabase,
	input: SplitPayInput,
): Promise<
	| {
			ok: true
			amounts: number[]
			paidCents: number
			closed: boolean
			paymentId: string
	  }
	| { ok: false; error: string }
> {
	const now = input.now ?? Date.now()
	const [settings] = await db.select().from(qrSettings).limit(1)
	const [tab] = await db
		.select()
		.from(qrTabs)
		.where(eq(qrTabs.id, input.tabId))
		.limit(1)
	if (!tab || tab.status !== 'open') return { ok: false, error: 'not_open' }
	if (tab.paymentStatus === 'pending') {
		return { ok: false, error: 'payment_in_progress' }
	}
	const parts = input.parts ?? 0
	const maxParts = settings?.splitMaxParts ?? 0
	if (parts > 0 && (maxParts <= 0 || parts > maxParts)) {
		return { ok: false, error: 'too_many_parts' }
	}
	const amounts =
		parts > 0 ? splitEqualCents(tab.totalCents, parts) : []
	const existing = await db
		.select()
		.from(qrTabPayments)
		.where(eq(qrTabPayments.tabId, tab.id))
	const succeeded = existing.filter((row) => row.splitStatus !== 'failed')
	const paidCents = succeeded.reduce((sum, row) => sum + row.amountCents, 0)
	const amount =
		input.amountCents ??
		amounts[succeeded.length] ??
		Math.max(0, tab.totalCents - paidCents)
	const min = settings?.splitMinBasketCents ?? 0
	if (min > 0 && amount < min && amount !== tab.totalCents - paidCents) {
		return { ok: false, error: 'below_minimum' }
	}
	if (amount <= 0) return { ok: false, error: 'nothing_due' }
	const ok = input.ok !== false
	const paymentId = `split-${input.sessionId}`
	await db.insert(qrTabPayments).values({
		id: paymentId,
		tabId: tab.id,
		sessionId: input.sessionId,
		processor: input.processor ?? 'mock',
		amountCents: amount,
		currency: tab.currency,
		receivedAt: now,
		splitIndex: succeeded.length,
		splitStatus: ok ? 'succeeded' : 'failed',
	})
	await db.insert(qrTabEvents).values({
		tabId: tab.id,
		kind: ok ? 'split_paid' : 'split_failed',
		actor: 'guest',
		detail: String(amount),
		createdAt: now,
	})
	const nextPaid = ok ? paidCents + amount : paidCents
	const covered = nextPaid >= tab.totalCents
	if (ok && covered) {
		await db
			.update(qrTabs)
			.set({
				status: 'closed',
				closedAt: now,
				closedBy: 'guest',
				closedByActor: 'guest',
				paymentStatus: 'paid',
				paidAt: now,
				updatedAt: now,
			})
			.where(eq(qrTabs.id, tab.id))
	}
	return {
		ok: true,
		amounts,
		paidCents: nextPaid,
		closed: ok && covered,
		paymentId,
	}
}
