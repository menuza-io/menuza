import { describe, expect, it } from 'vitest'
import { WAITLIST_NOW, makeWaitlistEntry } from './waitlist-fixtures.ts'
import { waitlistErrorMessage } from './waitlist-errors.ts'
import {
	applyOrder,
	availableActions,
	deadlineCountdown,
	formatCountdown,
	isQuoteExceeded,
	minutesSince,
	moveWithin,
	needsConfirmation,
	reorderByStep,
	sameOrder,
	splitMinutes,
	splitWaitlist,
	tableCandidates,
	waitlistChannelKey,
} from './waitlist-view.ts'
import { type LiveTableState } from './book-api.ts'

describe('waitlist-view', () => {
	it('puts the active queue in position order and settled parties after it', () => {
		const { active, settled } = splitWaitlist([
			makeWaitlistEntry({ id: 'late', position: 2 }),
			makeWaitlistEntry({ id: 'seated', status: 'seated', position: null }),
			makeWaitlistEntry({ id: 'first', position: 1, status: 'notified' }),
		])
		expect(active.map((e) => e.id)).toEqual(['first', 'late'])
		expect(settled.map((e) => e.id)).toEqual(['seated'])
	})

	it('splits minutes into hours and minutes', () => {
		expect(splitMinutes(65)).toEqual({ hours: 1, minutes: 5 })
		expect(splitMinutes(-4)).toEqual({ hours: 0, minutes: 0 })
	})

	it('measures how long a party has waited', () => {
		expect(minutesSince(WAITLIST_NOW - 12 * 60_000, WAITLIST_NOW)).toBe(12)
		expect(minutesSince(null, WAITLIST_NOW)).toBe(0)
		expect(minutesSince(WAITLIST_NOW + 5000, WAITLIST_NOW)).toBe(0)
	})

	it('flags a party that waited longer than the quote, only while active', () => {
		const entry = makeWaitlistEntry({
			id: 'w',
			quotedMin: 10,
			joinedAt: WAITLIST_NOW - 11 * 60_000,
		})
		expect(isQuoteExceeded(entry, WAITLIST_NOW)).toBe(true)
		expect(isQuoteExceeded({ ...entry, quotedMin: 11 }, WAITLIST_NOW)).toBe(
			false,
		)
		expect(isQuoteExceeded({ ...entry, quotedMin: null }, WAITLIST_NOW)).toBe(
			false,
		)
		expect(isQuoteExceeded({ ...entry, status: 'seated' }, WAITLIST_NOW)).toBe(
			false,
		)
	})

	it('counts down to the reply deadline and reports expiry', () => {
		const entry = makeWaitlistEntry({
			id: 'w',
			status: 'notified',
			responseDeadlineAt: WAITLIST_NOW + 272_000,
		})
		const left = deadlineCountdown(entry, WAITLIST_NOW)!
		expect(left.expired).toBe(false)
		expect(formatCountdown(left)).toBe('4:32')
		const gone = deadlineCountdown(entry, WAITLIST_NOW + 300_000)!
		expect(gone.expired).toBe(true)
		expect(formatCountdown(gone)).toBe('0:00')
	})

	it('has no countdown unless the party is notified with a deadline', () => {
		expect(
			deadlineCountdown(
				makeWaitlistEntry({ id: 'w', status: 'waiting' }),
				WAITLIST_NOW,
			),
		).toBeNull()
		expect(
			deadlineCountdown(
				makeWaitlistEntry({
					id: 'w',
					status: 'notified',
					responseDeadlineAt: null,
				}),
				WAITLIST_NOW,
			),
		).toBeNull()
	})

	it('mirrors the server transition table', () => {
		expect(availableActions('waiting', true).statuses).toEqual([
			'on_the_way',
			'left',
			'no_response',
			'cancelled',
		])
		expect(availableActions('waiting', true).notify).toBe(true)
		expect(availableActions('notified', true).notify).toBe(false)
		expect(availableActions('notified', true).statuses).toContain('waiting')
		expect(availableActions('no_response', true).statuses).toEqual(['waiting'])
		expect(availableActions('no_response', true).seat).toBe(false)
		for (const done of ['seated', 'cancelled', 'left'] as const) {
			const actions = availableActions(done, true)
			expect(actions.statuses).toEqual([])
			expect(actions.notify || actions.seat || actions.edit).toBe(false)
		}
	})

	it('offers no actions to a read-only member', () => {
		const actions = availableActions('waiting', false)
		expect(actions.statuses).toEqual([])
		expect(
			actions.notify || actions.seat || actions.edit || actions.reorder,
		).toBe(false)
	})

	it('asks before the changes that cannot be undone', () => {
		expect(needsConfirmation('cancelled')).toBe(true)
		expect(needsConfirmation('left')).toBe(true)
		expect(needsConfirmation('on_the_way')).toBe(false)
	})

	it('moves a party within the queue and clamps at the edges', () => {
		expect(moveWithin(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a'])
		expect(moveWithin(['a', 'b', 'c'], 'c', -5)).toEqual(['c', 'a', 'b'])
		expect(moveWithin(['a', 'b'], 'x', 0)).toEqual(['a', 'b'])
		expect(reorderByStep(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c'])
		expect(reorderByStep(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b'])
		expect(reorderByStep(['a', 'b', 'c'], 'a', -1)).toBeNull()
		expect(reorderByStep(['a', 'b', 'c'], 'c', 1)).toBeNull()
		expect(sameOrder(['a', 'b'], ['a', 'b'])).toBe(true)
		expect(sameOrder(['a', 'b'], ['b', 'a'])).toBe(false)
	})

	it('shows a pending order over polled entries and drops unknown ids', () => {
		const entries = [
			makeWaitlistEntry({ id: 'a' }),
			makeWaitlistEntry({ id: 'b' }),
			makeWaitlistEntry({ id: 'c' }),
		]
		expect(applyOrder(entries, ['c', 'ghost', 'a']).map((e) => e.id)).toEqual([
			'c',
			'a',
			'b',
		])
		expect(applyOrder(entries, null).map((e) => e.id)).toEqual(['a', 'b', 'c'])
	})

	it('ranks open tables that fit first', () => {
		const table = (
			tableId: string,
			status: LiveTableState['status'],
			minCovers: number,
			maxCovers: number,
		) => ({ tableId, status, minCovers, maxCovers }) as LiveTableState
		const ranked = tableCandidates(
			[
				table('seated-fit', 'seated', 2, 4),
				table('open-small', 'open', 1, 2),
				table('open-fit', 'open', 2, 6),
			],
			4,
		)
		expect(ranked.map((c) => c.table.tableId)).toEqual([
			'open-fit',
			'open-small',
			'seated-fit',
		])
		expect(ranked[0]).toMatchObject({ free: true, fits: true })
		expect(ranked[1]).toMatchObject({ free: true, fits: false })
	})

	it('labels the channel for the badge', () => {
		expect(waitlistChannelKey({ channel: 'remote' })).toBe('online')
		expect(waitlistChannelKey({ channel: 'walk_in' })).toBe('walk_in')
	})
})

describe('waitlist-errors', () => {
	const translate = (d: { message?: string; id?: string }) =>
		d.message ?? d.id ?? ''
	const fallback = { id: 'fallback', message: 'Fallback' }
	const apiError = (body: unknown, status = 409) =>
		Object.assign(new Error('x'), { status, body })

	it('maps known server codes to host-readable sentences', () => {
		expect(
			waitlistErrorMessage(
				apiError({ error: 'stale_version' }),
				translate,
				fallback,
			),
		).toMatch(/changed this party/)
		expect(
			waitlistErrorMessage(
				apiError({ error: 'duplicate_active_entry' }),
				translate,
				fallback,
			),
		).toMatch(/already on the waitlist/)
		expect(
			waitlistErrorMessage(
				apiError({ error: 'table_occupied' }),
				translate,
				fallback,
			),
		).toMatch(/taken/)
	})

	it('explains an invalid phone number', () => {
		expect(
			waitlistErrorMessage(
				apiError(
					{ error: 'invalid', issues: [{ path: 'phone', code: 'invalid' }] },
					400,
				),
				translate,
				fallback,
			),
		).toMatch(/valid phone number/)
	})

	it('falls back for unknown failures', () => {
		expect(waitlistErrorMessage(new Error('boom'), translate, fallback)).toBe(
			'Fallback',
		)
	})
})
