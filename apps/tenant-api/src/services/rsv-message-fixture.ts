import {
	getTenantDb,
	rsvGuests,
	rsvLocationSettings,
	rsvMessages,
	rsvNotifyRequests,
	rsvReservations,
	rsvWaitlistEntries,
	type TenantDatabase,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { type MessagingSettingsInput } from '../lib/reservations-messaging-settings.ts'
import { PUBLIC_LOC } from '../routes/reservations-public-fixture.ts'

/** Shared helpers for the guest-message tests: rows are inserted directly so each test controls every field. */

export const HOUR = 3_600_000
export const MINUTE = 60_000

/** A Tuesday noon in UTC; the fixture location runs in UTC. */
export const NOW = Date.UTC(2031, 5, 10, 12, 0)

let seq = 0
const next = () => ++seq

export async function insertGuest(
	db: TenantDatabase,
	patch: Partial<typeof rsvGuests.$inferInsert> = {},
) {
	const n = next()
	const id = patch.id ?? `gst_msg_${n}`
	const row = {
		id,
		firstName: 'Rana',
		lastName: 'Haddad',
		emailNorm: `rana${n}@example.com`,
		phoneE164: null,
		locale: 'en',
		...patch,
	}
	await db.insert(rsvGuests).values(row)
	return (await db.select().from(rsvGuests).where(eq(rsvGuests.id, id)).get())!
}

export async function insertReservation(
	db: TenantDatabase,
	patch: Partial<typeof rsvReservations.$inferInsert> & { guestId: string },
) {
	const n = next()
	const startAt = patch.startAt ?? NOW + 3 * 24 * HOUR + 7 * HOUR
	const id = patch.id ?? `rsv_msg_${n}`
	const row = {
		id,
		locationId: PUBLIC_LOC,
		confirmationCode: `MSG${String(n).padStart(4, '0')}`,
		businessDate: new Date(startAt).toISOString().slice(0, 10),
		localStartMin: new Date(startAt).getUTCHours() * 60,
		timeZone: 'UTC',
		startAt,
		endAt: startAt + 90 * MINUTE,
		durationMin: 90,
		partySize: 4,
		status: 'booked' as const,
		channel: 'online' as const,
		guestLocale: 'en',
		smsOptIn: false,
		...patch,
	}
	await db.insert(rsvReservations).values(row)
	return (await db
		.select()
		.from(rsvReservations)
		.where(eq(rsvReservations.id, id))
		.get())!
}

export async function insertWaitlistEntry(
	db: TenantDatabase,
	patch: Partial<typeof rsvWaitlistEntries.$inferInsert> = {},
) {
	const n = next()
	const id = patch.id ?? `wle_msg_${n}`
	await db.insert(rsvWaitlistEntries).values({
		id,
		locationId: PUBLIC_LOC,
		businessDate: '2031-06-10',
		displayName: 'Rana Haddad',
		emailNorm: `waiter${n}@example.com`,
		partySize: 2,
		status: 'waiting',
		quotedMin: 20,
		...patch,
	})
	return (await db
		.select()
		.from(rsvWaitlistEntries)
		.where(eq(rsvWaitlistEntries.id, id))
		.get())!
}

export async function insertNotifyRequest(
	db: TenantDatabase,
	patch: Partial<typeof rsvNotifyRequests.$inferInsert> = {},
) {
	const n = next()
	const id = patch.id ?? `nfy_msg_${n}`
	await db.insert(rsvNotifyRequests).values({
		id,
		locationId: PUBLIC_LOC,
		businessDate: '2031-06-14',
		partySize: 2,
		fromLocalMin: 17 * 60,
		toLocalMin: 19 * 60,
		contactEmailNorm: `notify${n}@example.com`,
		expiresAt: NOW + 7 * 24 * HOUR,
		...patch,
	})
	return (await db
		.select()
		.from(rsvNotifyRequests)
		.where(eq(rsvNotifyRequests.id, id))
		.get())!
}

export async function setMessaging(
	db: TenantDatabase,
	messaging: MessagingSettingsInput,
	locationId = PUBLIC_LOC,
) {
	await db
		.update(rsvLocationSettings)
		.set({ messaging })
		.where(eq(rsvLocationSettings.locationId, locationId))
}

export async function allMessages(db: TenantDatabase) {
	return db.select().from(rsvMessages).orderBy(rsvMessages.createdAt).all()
}

export async function messagesFor(
	db: TenantDatabase,
	reservationId: string,
	kind?: string,
) {
	const rows = await db
		.select()
		.from(rsvMessages)
		.where(eq(rsvMessages.reservationId, reservationId))
		.all()
	return rows
		.filter((row) => (kind ? row.kind === kind : true))
		.sort((a, b) => a.dedupeKey.localeCompare(b.dedupeKey))
}

export async function insertMessageRow(
	db: TenantDatabase,
	patch: Partial<typeof rsvMessages.$inferInsert> & {
		kind: (typeof rsvMessages.$inferInsert)['kind']
	},
) {
	const n = next()
	const id = patch.id ?? `msg_row_${n}`
	await db.insert(rsvMessages).values({
		id,
		locationId: PUBLIC_LOC,
		channel: 'email',
		category: 'transactional',
		locale: 'en',
		sendAt: NOW,
		nextAttemptAt: NOW,
		status: 'pending',
		attempts: 0,
		dedupeKey: `test:${id}`,
		createdAt: NOW,
		...patch,
	})
	return (await db
		.select()
		.from(rsvMessages)
		.where(eq(rsvMessages.id, id))
		.get())!
}

export async function getMessage(db: TenantDatabase, id: string) {
	return (await db
		.select()
		.from(rsvMessages)
		.where(eq(rsvMessages.id, id))
		.get())!
}

export async function dbFor(orgId: string) {
	return getTenantDb(orgId)
}
