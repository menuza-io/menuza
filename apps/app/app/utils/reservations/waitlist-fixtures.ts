import {
	type WaitlistEntry,
	type WaitlistListing,
} from '#app/utils/reservations/waitlist-api.ts'

export const WAITLIST_NOW = Date.UTC(2026, 3, 20, 18, 0, 0)

export function makeWaitlistEntry(
	overrides: Partial<WaitlistEntry> & { id: string },
): WaitlistEntry {
	return {
		locationId: 'loc_1',
		businessDate: '2026-04-20',
		guestId: null,
		displayName: `Guest ${overrides.id}`,
		firstName: 'Guest',
		lastName: overrides.id,
		phone: null,
		email: null,
		partySize: 2,
		areaPrefId: null,
		channel: 'walk_in',
		status: 'waiting',
		quotedMin: 20,
		quotedReadyAt: WAITLIST_NOW + 20 * 60_000,
		notifiedAt: null,
		responseDeadlineAt: null,
		reservationId: null,
		sortKey: 1,
		notes: null,
		smsOptIn: false,
		locale: 'en',
		version: 1,
		joinedAt: WAITLIST_NOW - 5 * 60_000,
		createdAt: WAITLIST_NOW - 5 * 60_000,
		position: 1,
		...overrides,
	}
}

export function makeWaitlistListing(
	entries: WaitlistEntry[],
	overrides: Partial<WaitlistListing> = {},
): WaitlistListing {
	const count = (status: WaitlistEntry['status']) =>
		entries.filter((entry) => entry.status === status).length
	return {
		locationId: 'loc_1',
		businessDate: '2026-04-20',
		now: WAITLIST_NOW,
		waitlistResponseMin: 10,
		counts: {
			active: count('waiting') + count('notified') + count('on_the_way'),
			waiting: count('waiting'),
			notified: count('notified'),
			onTheWay: count('on_the_way'),
		},
		entries,
		...overrides,
	}
}
