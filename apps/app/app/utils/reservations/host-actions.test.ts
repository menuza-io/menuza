import { describe, expect, it } from 'vitest'
import { ALL_RESERVATION_STATUSES } from '#app/components/reservations/status-style.tsx'
import {
	boardColumnFor,
	canMarkRunningLate,
	hostActionsFor,
} from './host-actions.ts'

describe('hostActionsFor', () => {
	it('gives each stage one primary action', () => {
		expect(hostActionsFor('booked').primary?.action).toBe('arrive')
		expect(hostActionsFor('confirmed').primary?.action).toBe('arrive')
		expect(hostActionsFor('arrived').primary?.action).toBe('seat')
		expect(hostActionsFor('seated').primary?.action).toBe('finish')
		expect(hostActionsFor('seated').primary?.to).toBe('finished')
		expect(hostActionsFor('pending_payment').primary?.action).toBe('confirm')
	})

	it('moves the rest into the menu, never repeating the primary', () => {
		for (const status of ALL_RESERVATION_STATUSES) {
			const { primary, secondary } = hostActionsFor(status)
			if (primary) {
				expect(secondary.map((a) => a.action)).not.toContain(primary.action)
			}
			expect(secondary.map((a) => a.action)).not.toContain('approve')
			expect(secondary.map((a) => a.action)).not.toContain('decline')
		}
		const booked = hostActionsFor('booked').secondary.map((a) => a.action)
		expect(booked).toEqual(
			expect.arrayContaining(['seat', 'no_show', 'cancel']),
		)
	})

	it('sends cancel to the detail sheet and keeps transitions as statuses', () => {
		const cancel = hostActionsFor('booked').secondary.find(
			(a) => a.action === 'cancel',
		)
		expect(cancel?.to).toBeNull()
		expect(
			hostActionsFor('arrived').secondary.find((a) => a.action === 'no_show')
				?.to,
		).toBe('no_show')
	})

	it('has no primary for a request waiting on approval or a closed booking', () => {
		expect(hostActionsFor('requested').primary).toBeNull()
		expect(hostActionsFor('cancelled').primary).toBeNull()
	})
})

describe('board columns', () => {
	it('puts every known status somewhere sensible', () => {
		expect(boardColumnFor('booked')).toBe('upcoming')
		expect(boardColumnFor('arrived')).toBe('upcoming')
		expect(boardColumnFor('seated')).toBe('seated')
		expect(boardColumnFor('finished')).toBe('finished')
		expect(boardColumnFor('completed')).toBe('finished')
		expect(boardColumnFor('requested')).toBe('requests')
		for (const status of ALL_RESERVATION_STATUSES) {
			expect(boardColumnFor(status)).toBeTruthy()
		}
	})

	it('allows running-late only before arrival', () => {
		expect(canMarkRunningLate('booked')).toBe(true)
		expect(canMarkRunningLate('seated')).toBe(false)
	})
})
