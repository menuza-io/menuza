import { describe, expect, it } from 'vitest'
import { maskPhone, redactContacts } from './reservations-station.ts'

describe('Station contact redaction', () => {
	it('keeps the end of a number so a host can recognise the guest', () => {
		expect(maskPhone('+12125550111')).toBe('•••• 0111')
		expect(maskPhone('12')).toBe('••••')
	})

	it('masks every phone and drops every email, however deep', () => {
		expect(
			redactContacts({
				reservations: [
					{
						guestPhone: '+14155550123',
						guest: {
							name: 'Maya Haddad',
							phoneE164: '+14155550123',
							phone_e164: '+14155550123',
							email: 'maya@example.com',
							emailNorm: 'maya@example.com',
						},
					},
				],
				waitlist: [{ phone: '+966500000001', email_norm: 'a@b.co' }],
				partySize: 2,
				phoneVerified: true,
			}),
		).toEqual({
			reservations: [
				{
					guestPhone: '•••• 0123',
					guest: {
						name: 'Maya Haddad',
						phoneE164: '•••• 0123',
						phone_e164: '•••• 0123',
						email: null,
						emailNorm: null,
					},
				},
			],
			waitlist: [{ phone: '•••• 0001', email_norm: null }],
			partySize: 2,
			phoneVerified: true,
		})
	})

	it('covers fields added later by their name, not a list', () => {
		expect(
			redactContacts({
				notify: {
					contactPhoneE164: '+14155550199',
					contactEmailNorm: 'x@example.com',
					hasPhone: true,
				},
			}),
		).toEqual({
			notify: {
				contactPhoneE164: '•••• 0199',
				contactEmailNorm: null,
				hasPhone: true,
			},
		})
	})
})
