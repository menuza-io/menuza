import {
	customerCarts,
	customers,
	getTenantDb,
	marketingJourneys,
	marketingSettings,
	orderJourneyEmissions,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, eq, gte, lt } from 'drizzle-orm'
import { z } from 'zod'
import {
	buildCartLinkUrl,
	CART_LINK_TTL_MS,
	issueCartToken,
} from '../lib/cart-link.ts'
import { errorLogFields } from '../lib/error-log.ts'
import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'
import { getReservationsContext } from '../lib/reservations-context.ts'
import { hasMarketingConsent } from './marketing-audience.ts'
import {
	claimEmission,
	ORDER_JOURNEY_BATCH,
	settleEmission,
	spawnJourneys,
} from './order-journeys.ts'

/**
 * Cart left behind (#150). A signed-in guest (verified phone) who agreed to
 * marketing quotes at checkout, and does not place an order within the delay
 * (default 1 hour, operator-editable), starts the `cart_left_behind` journey,
 * at most once per guest per 24 hours and only above a minimum cart value.
 *
 * The snapshot (`customer_carts`) holds ids and quantities only: no contact,
 * no address, no notes. Every quote overwrites it; an order, an emptied cart,
 * the 7-day cleanup and person erasure delete it. It is stored only while an
 * active cart journey exists and only for a guest who could be reminded, so no
 * cart is kept "just in case". Whether a message is sent is still decided by
 * the journey's steps (consent, frequency cap, the "ordered" goal).
 */

export const CART_REMINDER_KEY = 'cart_reminder'
export const DEFAULT_CART_DELAY_MINUTES = 60
export const MIN_CART_DELAY_MINUTES = 5
export const MAX_CART_DELAY_MINUTES = 24 * 60
/** One unit of currency, in minor units. */
export const DEFAULT_MIN_CART_MINOR = 100
export const CART_COOLDOWN_MS = 24 * 60 * 60_000
export const CART_SNAPSHOT_TTL_MS = CART_LINK_TTL_MS

export const cartReminderSettingsSchema = z
	.object({
		delayMinutes: z
			.number()
			.int()
			.min(MIN_CART_DELAY_MINUTES)
			.max(MAX_CART_DELAY_MINUTES),
		minCartMinor: z.number().int().min(0).max(10_000_000),
	})
	.strict()
export type CartReminderSettings = z.infer<typeof cartReminderSettingsSchema>

export const DEFAULT_CART_SETTINGS: CartReminderSettings = {
	delayMinutes: DEFAULT_CART_DELAY_MINUTES,
	minCartMinor: DEFAULT_MIN_CART_MINOR,
}

export async function readCartSettings(
	db: TenantDatabase,
): Promise<CartReminderSettings> {
	const row = await db
		.select({ value: marketingSettings.value })
		.from(marketingSettings)
		.where(eq(marketingSettings.key, CART_REMINDER_KEY))
		.get()
	const parsed = cartReminderSettingsSchema.safeParse(
		typeof row?.value === 'string' ? safeJson(row.value) : row?.value,
	)
	return parsed.success ? parsed.data : DEFAULT_CART_SETTINGS
}

export async function writeCartSettings(
	db: TenantDatabase,
	value: CartReminderSettings,
): Promise<void> {
	await db
		.insert(marketingSettings)
		.values({ key: CART_REMINDER_KEY, value, updatedAt: Date.now() })
		.onConflictDoUpdate({
			target: marketingSettings.key,
			set: { value, updatedAt: Date.now() },
		})
}

function safeJson(raw: string): unknown {
	try {
		return JSON.parse(raw)
	} catch {
		return null
	}
}

/** What a cart line keeps: ids and quantities. Never the guest's free-text notes. */
export type CartSnapshotLine = {
	itemId: string
	variantId?: string
	quantity: number
	options: Array<{
		groupId: string
		optionId: string
		half?: 'whole' | 'left' | 'right'
		quantity?: number
	}>
}

export function toSnapshotLines(
	lines: ReadonlyArray<{
		itemId: string
		variantId?: string
		quantity: number
		options?: ReadonlyArray<{
			groupId: string
			optionId: string
			half?: 'whole' | 'left' | 'right'
			quantity?: number
		}>
	}>,
): CartSnapshotLine[] {
	return lines.map((line) => ({
		itemId: line.itemId,
		...(line.variantId ? { variantId: line.variantId } : {}),
		quantity: line.quantity,
		options: (line.options ?? []).map((option) => ({
			groupId: option.groupId,
			optionId: option.optionId,
			...(option.half ? { half: option.half } : {}),
			...(option.quantity ? { quantity: option.quantity } : {}),
		})),
	}))
}

async function hasActiveCartJourney(db: TenantDatabase): Promise<boolean> {
	const row = await db
		.select({ id: marketingJourneys.id })
		.from(marketingJourneys)
		.where(
			and(
				eq(marketingJourneys.status, 'active'),
				eq(marketingJourneys.triggerType, 'cart_left_behind'),
			),
		)
		.limit(1)
		.get()
	return Boolean(row)
}

/** A guest who could be reminded: a verified phone and marketing consent on a channel. */
export async function canBeReminded(
	db: TenantDatabase,
	customerId: string,
): Promise<boolean> {
	const customer = await db
		.select({ phoneVerified: customers.phoneVerified })
		.from(customers)
		.where(eq(customers.id, customerId))
		.get()
	if (!customer?.phoneVerified) return false
	return (
		(await hasMarketingConsent(db, customerId, 'sms')) ||
		(await hasMarketingConsent(db, customerId, 'email'))
	)
}

export async function clearCartSnapshot(
	db: TenantDatabase,
	customerId: string,
): Promise<void> {
	// A read first: most guests have no snapshot, and a write here would take
	// the database's write lock for nothing, right after an order committed.
	const found = await db
		.select({ customerId: customerCarts.customerId })
		.from(customerCarts)
		.where(eq(customerCarts.customerId, customerId))
		.get()
	if (!found) return
	await retryOnSqliteBusy(() =>
		db.delete(customerCarts).where(eq(customerCarts.customerId, customerId)),
	)
}

/**
 * Called on every quote of a signed-in guest. Stores (or replaces) the
 * snapshot only when a cart journey is active and the guest could be reminded;
 * otherwise it removes any snapshot. Never throws: a quote must not fail
 * because of marketing.
 */
export async function recordCartSnapshot(
	db: TenantDatabase,
	input: {
		customerId: string
		locationId: string
		currency: string
		subtotalMinor: number
		lines: CartSnapshotLine[]
		now?: number
	},
): Promise<void> {
	try {
		if (
			input.lines.length === 0 ||
			!(await hasActiveCartJourney(db)) ||
			!(await canBeReminded(db, input.customerId))
		) {
			await clearCartSnapshot(db, input.customerId)
			return
		}
		const now = input.now ?? Date.now()
		await db
			.insert(customerCarts)
			.values({
				customerId: input.customerId,
				locationId: input.locationId,
				currency: input.currency,
				subtotalCents: input.subtotalMinor,
				items: input.lines,
				updatedAt: now,
				remindedAt: null,
			})
			.onConflictDoUpdate({
				target: customerCarts.customerId,
				set: {
					locationId: input.locationId,
					currency: input.currency,
					subtotalCents: input.subtotalMinor,
					items: input.lines,
					updatedAt: now,
					remindedAt: null,
				},
			})
	} catch (error) {
		console.error('Cart snapshot could not be saved', errorLogFields(error))
	}
}

/** The cart a restore link points at: ids and quantities, nothing about the guest. */
export async function readCartForRestore(
	db: TenantDatabase,
	customerId: string,
	now: number = Date.now(),
) {
	const row = await db
		.select()
		.from(customerCarts)
		.where(
			and(
				eq(customerCarts.customerId, customerId),
				gte(customerCarts.updatedAt, now - CART_SNAPSHOT_TTL_MS),
			),
		)
		.get()
	if (!row) return null
	return {
		locationId: row.locationId,
		currency: row.currency,
		lines: (typeof row.items === 'string'
			? safeJson(row.items)
			: row.items) as CartSnapshotLine[],
	}
}

/** The link a reminder carries, or null when there is no cart or no site address to point at. */
export async function cartLinkForGuest(
	orgId: string,
	customerId: string,
	now: number = Date.now(),
): Promise<string | null> {
	const db = await getTenantDb(orgId)
	const cart = await readCartForRestore(db, customerId, now)
	if (!cart) return null
	const context = await getReservationsContext(orgId)
	return buildCartLinkUrl({
		siteOrigin: context?.organization.siteOrigin,
		token: issueCartToken({ orgId, customerId, now }),
	})
}

/**
 * The tick's part: deletes snapshots older than 7 days, then starts the cart
 * journey for guests whose cart has sat for the delay, once per snapshot and
 * once per guest per 24 hours. Consent is checked again here (a guest who
 * unsubscribed since is not started, and their snapshot is dropped).
 */
export async function runCartJourneys(
	orgId: string,
	options: { now?: number } = {},
): Promise<{ started: number }> {
	const now = options.now ?? Date.now()
	let started = 0
	try {
		const db = await getTenantDb(orgId)
		await db
			.delete(customerCarts)
			.where(lt(customerCarts.updatedAt, now - CART_SNAPSHOT_TTL_MS))
		if (!(await hasActiveCartJourney(db))) return { started: 0 }
		const settings = await readCartSettings(db)
		const due = await db
			.select()
			.from(customerCarts)
			.where(lt(customerCarts.updatedAt, now - settings.delayMinutes * 60_000))
			.limit(ORDER_JOURNEY_BATCH * 4)
			.all()
		for (const cart of due) {
			if (started >= ORDER_JOURNEY_BATCH) break
			if (cart.subtotalCents < settings.minCartMinor) continue
			if (!(await canBeReminded(db, cart.customerId))) {
				await clearCartSnapshot(db, cart.customerId)
				continue
			}
			// At most once per guest per 24 hours, whatever the snapshot.
			const recent = await db
				.select({ ref: orderJourneyEmissions.ref })
				.from(orderJourneyEmissions)
				.where(
					and(
						eq(orderJourneyEmissions.customerId, cart.customerId),
						eq(orderJourneyEmissions.trigger, 'cart_left_behind'),
						gte(orderJourneyEmissions.emittedAt, now - CART_COOLDOWN_MS),
					),
				)
				.limit(1)
				.get()
			if (recent) continue
			const emission = {
				customerId: cart.customerId,
				trigger: 'cart_left_behind',
				ref: `cart:${cart.updatedAt}`,
			}
			if (!(await claimEmission(db, emission, now))) continue
			try {
				await spawnJourneys(
					orgId,
					'cart_left_behind',
					cart.customerId,
					undefined,
					{ cartUpdatedAt: cart.updatedAt },
				)
			} catch (error) {
				console.error('Cart journey could not start', {
					orgId,
					...errorLogFields(error),
				})
				await settleEmission(db, emission, false, now).catch(() => {})
				continue
			}
			await settleEmission(db, emission, true, now)
			await db
				.update(customerCarts)
				.set({ remindedAt: now })
				.where(eq(customerCarts.customerId, cart.customerId))
			started += 1
		}
	} catch (error) {
		console.error('Cart journeys could not run', {
			orgId,
			...errorLogFields(error),
		})
	}
	return { started }
}
