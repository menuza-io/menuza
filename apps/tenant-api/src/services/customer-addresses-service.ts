import {
	SAVED_ADDRESS_LIMIT,
	orderSavedAddresses,
	type CreateSavedAddressRequest,
	type SavedAddress,
	type UpdateSavedAddressRequest,
} from '@repo/common/saved-addresses'
import {
	customerAddresses,
	runTenantTransaction,
	type CustomerAddress,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm'

import { verifyDeliveryQuote } from '../lib/delivery-quote-token.ts'
import { HttpError, notFound } from '../lib/http.ts'
import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'
import { runExclusive } from './order-service.ts'

/**
 * Saved delivery addresses on the guest account (#113). Regional rows, owned
 * by one customer: every read and write filters by the token's customer id, so
 * another guest's address id answers the same 404 as an id that does not exist.
 * The point is the one a successful geocode signed into a delivery quote token,
 * never free text, and it is re-quoted (zones and fees change) every time the
 * address is used at checkout.
 */

export function addressNotFound(): HttpError {
	return notFound('address_not_found', 'Address not found.')
}

/** What a client sees: never the coordinates. */
export function toSavedAddress(row: CustomerAddress): SavedAddress {
	return {
		id: row.id,
		label: row.label,
		formatted: row.formatted,
		line1: row.line1,
		unit: row.unit,
		city: row.city,
		state: row.state,
		postalCode: row.postalCode,
		country: row.country,
		notes: row.notes,
		isDefault: row.isDefault,
		createdAt: row.createdAt,
	}
}

export async function listSavedAddresses(
	db: TenantDatabase,
	customerId: string,
): Promise<SavedAddress[]> {
	const rows = await db
		.select()
		.from(customerAddresses)
		.where(eq(customerAddresses.customerId, customerId))
		.orderBy(
			desc(customerAddresses.isDefault),
			desc(customerAddresses.createdAt),
		)
	return orderSavedAddresses(rows.map(toSavedAddress))
}

/** The owner's row, or null (missing and another guest's look the same). */
export async function findSavedAddress(
	db: TenantDatabase,
	customerId: string,
	id: string,
): Promise<CustomerAddress | null> {
	const [row] = await db
		.select()
		.from(customerAddresses)
		.where(
			and(
				eq(customerAddresses.id, id),
				eq(customerAddresses.customerId, customerId),
			),
		)
		.limit(1)
	return row ?? null
}

function cleanNotes(value: string | null | undefined): string | null {
	const trimmed = (value ?? '').trim()
	return trimmed ? trimmed : null
}

export async function createSavedAddress(
	orgId: string,
	db: TenantDatabase,
	customerId: string,
	input: CreateSavedAddressRequest,
	now = Date.now(),
): Promise<SavedAddress> {
	const verified = await verifyDeliveryQuote(input.quoteToken, {
		orgId,
		locationId: input.locationId,
		now: new Date(now),
	})
	if (!verified.ok) {
		throw new HttpError(
			422,
			'invalid_quote_token',
			'Check this address again, then save it.',
		)
	}
	const quote = verified.payload
	return runExclusive(orgId, () =>
		retryOnSqliteBusy(() =>
			runTenantTransaction(db, async (tx) => {
				const [{ count } = { count: 0 }] = await tx
					.select({ count: sql<number>`count(*)` })
					.from(customerAddresses)
					.where(eq(customerAddresses.customerId, customerId))
				if (Number(count) >= SAVED_ADDRESS_LIMIT) {
					throw new HttpError(
						409,
						'address_limit_reached',
						`You can save up to ${SAVED_ADDRESS_LIMIT} addresses.`,
						{ limit: SAVED_ADDRESS_LIMIT },
					)
				}
				const makeDefault = Number(count) === 0 || input.makeDefault === true
				if (makeDefault) {
					await tx
						.update(customerAddresses)
						.set({ isDefault: false, updatedAt: now })
						.where(eq(customerAddresses.customerId, customerId))
				}
				const [row] = await tx
					.insert(customerAddresses)
					.values({
						customerId,
						label: input.label,
						formatted: quote.formatted,
						line1: quote.line1,
						unit: quote.unit,
						city: quote.city,
						state: quote.state,
						postalCode: quote.postalCode,
						country: quote.country,
						notes: cleanNotes(input.notes),
						lat: quote.lat,
						lng: quote.lng,
						isDefault: makeDefault,
						createdAt: now,
						updatedAt: now,
					})
					.returning()
				return toSavedAddress(row!)
			}),
		),
	)
}

export async function updateSavedAddress(
	orgId: string,
	db: TenantDatabase,
	customerId: string,
	id: string,
	patch: UpdateSavedAddressRequest,
	now = Date.now(),
): Promise<SavedAddress> {
	return runExclusive(orgId, () =>
		retryOnSqliteBusy(() =>
			runTenantTransaction(db, async (tx) => {
				const [existing] = await tx
					.select()
					.from(customerAddresses)
					.where(
						and(
							eq(customerAddresses.id, id),
							eq(customerAddresses.customerId, customerId),
						),
					)
					.limit(1)
				if (!existing) throw addressNotFound()
				if (patch.isDefault) {
					await tx
						.update(customerAddresses)
						.set({ isDefault: false, updatedAt: now })
						.where(
							and(
								eq(customerAddresses.customerId, customerId),
								ne(customerAddresses.id, id),
							),
						)
				}
				const [row] = await tx
					.update(customerAddresses)
					.set({
						...(patch.label !== undefined ? { label: patch.label } : {}),
						...(patch.unit !== undefined
							? { unit: cleanNotes(patch.unit) }
							: {}),
						...(patch.notes !== undefined
							? { notes: cleanNotes(patch.notes) }
							: {}),
						...(patch.isDefault ? { isDefault: true } : {}),
						updatedAt: now,
					})
					.where(eq(customerAddresses.id, id))
					.returning()
				return toSavedAddress(row!)
			}),
		),
	)
}

/**
 * Deletes one address. When it was the default, the newest remaining address
 * becomes the default so the account always has one while it has any.
 */
export async function deleteSavedAddress(
	orgId: string,
	db: TenantDatabase,
	customerId: string,
	id: string,
	now = Date.now(),
): Promise<void> {
	await runExclusive(orgId, () =>
		retryOnSqliteBusy(() =>
			runTenantTransaction(db, async (tx) => {
				const [existing] = await tx
					.select()
					.from(customerAddresses)
					.where(
						and(
							eq(customerAddresses.id, id),
							eq(customerAddresses.customerId, customerId),
						),
					)
					.limit(1)
				if (!existing) throw addressNotFound()
				await tx.delete(customerAddresses).where(eq(customerAddresses.id, id))
				if (existing.isDefault) {
					const [next] = await tx
						.select({ id: customerAddresses.id })
						.from(customerAddresses)
						.where(eq(customerAddresses.customerId, customerId))
						.orderBy(
							desc(customerAddresses.createdAt),
							asc(customerAddresses.id),
						)
						.limit(1)
					if (next) {
						await tx
							.update(customerAddresses)
							.set({ isDefault: true, updatedAt: now })
							.where(eq(customerAddresses.id, next.id))
					}
				}
			}),
		),
	)
}
