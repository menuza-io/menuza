import { createHash } from 'node:crypto'
import {
	inventoryNotifyDedupeKey,
	MAX_SOLD_OUT_ALERT_ENTRIES,
	type InventoryNotifyEvent,
	type SoldOutAlertEntry,
} from '@repo/inventory'
import {
	getTenantDb,
	invItems,
	invSoldOutAlerts,
	type TenantDatabase,
	type TenantTransaction,
} from '@repo/tenant-db'
import { and, eq, inArray, isNotNull, isNull, lt, max } from 'drizzle-orm'
import { queryInChunks } from '../lib/chunked-in.ts'
import {
	postInventoryNotify,
	type InventoryNotifyOutcome,
} from '../lib/inventory-notify.ts'
import { newId } from './inventory-common.ts'

/**
 * Alerts for dishes taken off the menu by stock, and for their return (#478).
 * The auto sold-out sync writes one outbox row per dish in its own
 * transaction (`queueSoldOutAlerts`); `dispatchSoldOutAlerts` groups the rows
 * of a location into ONE alert per kind per 15 minutes and hands it to the
 * App's inventory notify route, where the existing manager-alert engine
 * (members, quiet hours, snooze, the alert log, in-app, email, push) takes
 * over. Ids and the ingredient's name only: no guest data.
 *
 * - A dish that comes back before its sold-out alert went out cancels both:
 *   nobody is told about something that no longer holds.
 * - Rows are only marked sent once the App took the alert; until then the
 *   next run (every inventory write, the tick, the alarm) tries again.
 */

export const SOLD_OUT_ALERT_WINDOW_MS = 15 * 60 * 1000
export const SOLD_OUT_ALERT_RETRY_MS = 5 * 60 * 1000
const KEEP_MS = 14 * 24 * 60 * 60 * 1000

export type QueuedSoldOutAlert = {
	locationId: string
	kind: 'out' | 'back'
	entityType: 'item' | 'modifier_option'
	entityId: string
	causeItemId: string
}

export async function queueSoldOutAlerts(
	tx: TenantTransaction,
	rows: readonly QueuedSoldOutAlert[],
	now: number,
): Promise<void> {
	for (const row of rows) {
		await tx.insert(invSoldOutAlerts).values({
			id: newId(),
			...row,
			createdAt: now,
		})
	}
}

function eventIdFor(input: {
	orgId: string
	kind: 'inventory_sold_out' | 'inventory_sold_out_back'
	locationId: string
	key: string
}): string {
	return createHash('sha256')
		.update(inventoryNotifyDedupeKey(input))
		.digest('hex')
		.slice(0, 32)
}

export type SoldOutAlertResult = {
	/** Alerts the App took this run. */
	sent: number
	/** When a held-back or failed alert should be tried again, or null. */
	dueAt: number | null
}

export async function dispatchSoldOutAlerts(
	orgId: string,
	options: {
		now?: number
		db?: TenantDatabase
		post?: (event: InventoryNotifyEvent) => Promise<InventoryNotifyOutcome>
	} = {},
): Promise<SoldOutAlertResult> {
	const now = options.now ?? Date.now()
	const post = options.post ?? postInventoryNotify
	const db = options.db ?? (await getTenantDb(orgId))
	const result: SoldOutAlertResult = { sent: 0, dueAt: null }
	const pending = await db
		.select()
		.from(invSoldOutAlerts)
		.where(isNull(invSoldOutAlerts.sentAt))
		.orderBy(invSoldOutAlerts.createdAt, invSoldOutAlerts.id)
	if (pending.length === 0) {
		await db
			.delete(invSoldOutAlerts)
			.where(lt(invSoldOutAlerts.createdAt, now - KEEP_MS))
		return result
	}
	const soon = (at: number) => {
		result.dueAt = result.dueAt === null ? at : Math.min(result.dueAt, at)
	}

	// A dish that came back before anyone was told it went: nothing to say.
	const cancelled = new Set<string>()
	for (const back of pending.filter((row) => row.kind === 'back')) {
		const out = pending.find(
			(row) =>
				row.kind === 'out' &&
				!cancelled.has(row.id) &&
				row.locationId === back.locationId &&
				row.entityType === back.entityType &&
				row.entityId === back.entityId,
		)
		if (out) {
			cancelled.add(out.id)
			cancelled.add(back.id)
		}
	}
	if (cancelled.size > 0) {
		await db
			.update(invSoldOutAlerts)
			.set({ sentAt: now })
			.where(inArray(invSoldOutAlerts.id, [...cancelled]))
	}
	const live = pending.filter((row) => !cancelled.has(row.id))

	const locations = [...new Set(live.map((row) => row.locationId))].sort()
	for (const locationId of locations) {
		for (const kind of ['out', 'back'] as const) {
			const rows = live.filter(
				(row) => row.locationId === locationId && row.kind === kind,
			)
			if (rows.length === 0) continue
			const last = await db
				.select({ at: max(invSoldOutAlerts.sentAt) })
				.from(invSoldOutAlerts)
				.where(
					and(
						eq(invSoldOutAlerts.locationId, locationId),
						eq(invSoldOutAlerts.kind, kind),
						isNotNull(invSoldOutAlerts.eventId),
					),
				)
				.get()
			if (last?.at && now < last.at + SOLD_OUT_ALERT_WINDOW_MS) {
				// One alert per location per 15 minutes: these wait for the next window.
				soon(last.at + SOLD_OUT_ALERT_WINDOW_MS)
				continue
			}
			const causeIds = [...new Set(rows.map((row) => row.causeItemId))]
			const names = new Map(
				(
					await queryInChunks(causeIds, (chunk) =>
						db
							.select({ id: invItems.id, name: invItems.name })
							.from(invItems)
							.where(inArray(invItems.id, chunk)),
					)
				).map((row) => [row.id, row.name]),
			)
			const entries: SoldOutAlertEntry[] = rows
				.slice(0, MAX_SOLD_OUT_ALERT_ENTRIES)
				.map((row) => ({
					entityType: row.entityType,
					entityId: row.entityId,
					ingredientId: row.causeItemId,
					ingredientName:
						(names.get(row.causeItemId) ?? '').slice(0, 80) || '-',
				}))
			const notifyKind =
				kind === 'out' ? 'inventory_sold_out' : 'inventory_sold_out_back'
			const eventId = eventIdFor({
				orgId,
				kind: notifyKind,
				locationId,
				key: rows[0]!.id,
			})
			const outcome = await post({
				orgId,
				eventId,
				kind: notifyKind,
				locationId,
				count: Math.min(rows.length, 10_000),
				soldOut: entries,
			})
			if (outcome.status === 'retry') {
				soon(now + SOLD_OUT_ALERT_RETRY_MS)
				continue
			}
			if (outcome.status === 'rejected') {
				console.error('Inventory sold-out alert was refused', {
					orgId,
					code: outcome.code,
				})
			}
			// Delivered, or refused for good: either way these rows are done.
			await db
				.update(invSoldOutAlerts)
				.set({
					sentAt: now,
					eventId: outcome.status === 'delivered' ? eventId : null,
				})
				.where(
					inArray(
						invSoldOutAlerts.id,
						rows.map((row) => row.id),
					),
				)
			if (outcome.status === 'delivered') result.sent += 1
		}
	}
	await db
		.delete(invSoldOutAlerts)
		.where(lt(invSoldOutAlerts.createdAt, now - KEEP_MS))
	return result
}
