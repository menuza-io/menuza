import { i18n } from '@lingui/core'
import { describe, expect, it } from 'vitest'
import { HostApiError } from './api.ts'
import { refusalMessage, wantsAnotherTable } from './refusals.ts'

const say = (code: string, context?: Parameters<typeof refusalMessage>[1]) =>
	i18n._(refusalMessage(new HostApiError(409, code), context))

describe('what a refusal means', () => {
	it('does not call a table that is due to someone else a change someone made', () => {
		const error = new HostApiError(409, 'locked_table_conflict')
		// The old rule read "conflict" in the code as a stale version.
		expect(error.stale).toBe(false)
		expect(say('locked_table_conflict')).toBe(
			'The next party is due at this table. Choose another table or ask a manager.',
		)
	})
	it('only a stale version is a change someone made', () => {
		expect(new HostApiError(409, 'stale_version').stale).toBe(true)
		for (const code of [
			'locked_table_conflict',
			'version_unsupported',
			'idempotency_conflict',
			'table_blocked',
			'conflict',
			'stale',
		])
			expect(new HostApiError(409, code).stale).toBe(false)
		// A stale version is a 409.
		expect(new HostApiError(400, 'stale_version').stale).toBe(false)
	})
	it('says each seating refusal honestly', () => {
		expect(say('table_blocked')).toBe(
			'That table is blocked during their stay.',
		)
		expect(say('pacing_exceeded')).toBe(
			'That time is full. A manager can allow it.',
		)
		expect(say('pacing_parties_exceeded')).toBe(
			'That time is full. A manager can allow it.',
		)
		expect(say('party_too_large_for_table')).toBe(
			'No room for that many at their table. Move them to a bigger table.',
		)
		expect(say('reflow_failed')).toBe('No table fits that now.')
		expect(say('no_availability')).toBe('No table fits that now.')
		expect(say('invalid_status')).toBe('This booking is no longer open.')
		expect(say('reservation_not_active')).toBe(
			'This booking is no longer open.',
		)
		expect(say('in_the_past')).toBe('That time has passed.')
	})
	it('says a time that is gone when booking, and a table that fits not when seating', () => {
		expect(say('no_availability', 'book')).toBe(
			'That time is no longer available. Choose another.',
		)
		expect(say('slot_unavailable')).toBe(
			'That time is no longer available. Choose another.',
		)
	})
	it('keeps what it said before for money, permissions and a step that cannot be taken', () => {
		expect(say('manager_required')).toBe(
			'This booking has a payment on it. A manager handles it in the app.',
		)
		expect(say('not_today')).toBe(
			'That cannot be done to this booking now. Here is the latest.',
		)
		expect(say('something_new')).toBe('That did not go through. Try again.')
	})
	it('says a longer stay is a manager’s, not that there is a payment', () => {
		expect(say('manager_required', 'stay')).toBe(
			'A longer stay is a manager’s to set in the app.',
		)
	})
	it('says a step the server has no rule for is not available, not that the booking changed', () => {
		expect(say('invalid_status_transition', 'partial')).toBe(
			'Marking part of a party is not available from this till yet.',
		)
		expect(say('invalid_status_transition', 'reopen')).toBe(
			'A no-show cannot be reopened from a till. Seat them as a walk-in instead.',
		)
		expect(say('invalid_status_transition')).toBe(
			'That cannot be done to this booking now. Here is the latest.',
		)
	})
	it('says nothing special for no failure', () => {
		expect(i18n._(refusalMessage(null))).toBe(
			'That did not go through. Try again.',
		)
	})
	it('does not take a blocked table for an occupied one (no "Seat anyway")', () => {
		expect(new HostApiError(409, 'table_blocked').occupied).toBe(false)
		expect(new HostApiError(409, 'table_occupied').occupied).toBe(true)
	})
})

describe('a refusal about the table chosen', () => {
	it('puts the party back in hand for another table', () => {
		for (const code of [
			'locked_table_conflict',
			'table_blocked',
			'table_occupied',
			'reflow_failed',
			'no_availability',
		])
			expect(wantsAnotherTable(new HostApiError(409, code))).toBe(true)
	})
	it('does not, for a refusal about the booking or the connection', () => {
		for (const code of [
			'stale_version',
			'manager_required',
			'invalid_status',
			'in_the_past',
			'party_too_large_for_table',
		])
			expect(wantsAnotherTable(new HostApiError(409, code))).toBe(false)
		expect(wantsAnotherTable(null)).toBe(false)
	})
})
