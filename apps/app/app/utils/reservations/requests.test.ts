import { describe, expect, it } from 'vitest'
import {
	type DecidedRequest,
	isPendingRequestStatus,
	selectPendingRequests,
} from './requests.ts'

describe('reservation requests', () => {
	it('treats pending_approval and requested as pending', () => {
		expect(isPendingRequestStatus('pending_approval')).toBe(true)
		expect(isPendingRequestStatus('requested')).toBe(true)
		expect(isPendingRequestStatus('booked')).toBe(false)
		expect(isPendingRequestStatus('declined')).toBe(false)
		expect(isPendingRequestStatus(null)).toBe(false)
	})

	it('hides requests decided in this session even if the feed still lists them', () => {
		const rows = [
			{ id: 'a', status: 'pending_approval' },
			{ id: 'b', status: 'pending_approval' },
			{ id: 'c', status: 'booked' },
		]
		const decided = new Map<string, DecidedRequest>([
			[
				'a',
				{
					id: 'a',
					outcome: 'declined',
					guestName: 'Ada',
					partySize: 12,
					hhmm: '19:00',
				},
			],
		])
		expect(selectPendingRequests(rows, decided).map((r) => r.id)).toEqual(['b'])
	})
})
