import { RESERVATION_MESSAGE_KEYS } from './format'
import { RESERVATION_MESSAGES, renderReservationMessage } from './messages'
import { testI18n } from '@/test/loyalty/i18n'

const PLACEHOLDERS: Record<string, string[]> = {
	'rsv.search.partyCount': ['count'],
	'rsv.search.largePartyContact': ['phone'],
	'rsv.details.holding': ['time'],
	'rsv.details.phoneNote': ['phone'],
	'rsv.policy.deposit': ['amount'],
	'rsv.policy.freeCancelHours': ['count'],
	'rsv.policy.lateFee': ['amount'],
	'rsv.policy.noShowFee': ['amount'],
	'rsv.pay.amount': ['amount'],
	'rsv.pay.expires': ['time'],
	'rsv.detail.lateMinutes': ['count'],
	'rsv.detail.deadline': ['time'],
	'rsv.waitlist.position': ['position'],
	'rsv.waitlist.quoted': ['count'],
}

/** The top-level `{name}` and `{name, plural, ...}` arguments of a message. */
function argumentsOf(message: string): string[] {
	const names = new Set<string>()
	let depth = 0
	for (let index = 0; index < message.length; index += 1) {
		const character = message[index]
		if (character === '{') {
			if (depth === 0) {
				const match = /^\{(\w+)/.exec(message.slice(index))
				if (match?.[1]) names.add(match[1])
			}
			depth += 1
		} else if (character === '}') {
			depth -= 1
		}
	}
	return [...names].sort()
}

describe('reservation messages', () => {
	it('has an English message for every key, in the key order, and nothing else', () => {
		expect(Object.keys(RESERVATION_MESSAGES)).toEqual([
			...RESERVATION_MESSAGE_KEYS,
		])
		for (const key of RESERVATION_MESSAGE_KEYS) {
			expect({ key, message: RESERVATION_MESSAGES[key].message }).toEqual({
				key,
				message: expect.stringMatching(/\S/),
			})
		}
	})

	it('takes exactly the named values each screen passes', () => {
		for (const key of RESERVATION_MESSAGE_KEYS) {
			expect({
				key,
				names: argumentsOf(String(RESERVATION_MESSAGES[key].message)),
			}).toEqual({
				key,
				names: PLACEHOLDERS[key] ?? [],
			})
		}
	})

	it('renders the values it is given', () => {
		const i18n = testI18n('en')
		expect(
			renderReservationMessage(i18n, 'rsv.details.holding', { time: '6:42' }),
		).toBe("We're holding your table for 6:42")
		expect(
			renderReservationMessage(i18n, 'rsv.search.largePartyContact', {
				phone: '+1 212',
			}),
		).toBe('For a group this size, please call +1 212.')
		expect(
			renderReservationMessage(i18n, 'rsv.pay.amount', { amount: '$100.00' }),
		).toBe('Amount due: $100.00')
		expect(
			renderReservationMessage(i18n, 'rsv.waitlist.position', { position: 3 }),
		).toBe("You're number 3 in line")
		expect(
			renderReservationMessage(i18n, 'rsv.detail.lateMinutes', { count: 15 }),
		).toBe('15 min')
		expect(renderReservationMessage(i18n, 'rsv.home.book')).toBe('Book a table')
	})

	it('picks the plural form from the count', () => {
		const i18n = testI18n('en')
		expect(
			renderReservationMessage(i18n, 'rsv.search.partyCount', { count: 1 }),
		).toBe('1 guest')
		expect(
			renderReservationMessage(i18n, 'rsv.search.partyCount', { count: 4 }),
		).toBe('4 guests')
		expect(
			renderReservationMessage(i18n, 'rsv.policy.freeCancelHours', {
				count: 1,
			}),
		).toBe('Free cancellation until 1 hour before.')
		expect(
			renderReservationMessage(i18n, 'rsv.policy.freeCancelHours', {
				count: 24,
			}),
		).toBe('Free cancellation until 24 hours before.')
	})
})
