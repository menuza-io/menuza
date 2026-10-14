import { describe, expect, it } from 'vitest'
import { DEMO_POSITIONS, DEMO_STAFF } from './demo-roster.ts'
import { staffCreateSchema, staffPositionCreateSchema } from './staff-api.ts'

describe('demo roster', () => {
	it('is a dozen people', () => {
		expect(DEMO_STAFF).toHaveLength(12)
	})

	it('passes the same schemas the API enforces', () => {
		for (const position of DEMO_POSITIONS) {
			const parsed = staffPositionCreateSchema.safeParse({
				...position,
				currency: 'USD',
			})
			expect(parsed.success, position.name).toBe(true)
		}
		for (const person of DEMO_STAFF) {
			const {
				positions: ignoredPositions,
				rateMinor: ignoredRate,
				...input
			} = person
			const parsed = staffCreateSchema.safeParse(input)
			expect(parsed.success, person.firstName).toBe(true)
		}
	})

	it('reaches every person by phone or email', () => {
		for (const person of DEMO_STAFF) {
			expect(Boolean(person.phone || person.email), person.firstName).toBe(true)
		}
	})

	it('only uses positions that exist and keeps phones and emails unique and fictional', () => {
		const names = new Set(DEMO_POSITIONS.map((position) => position.name))
		for (const person of DEMO_STAFF) {
			for (const position of person.positions) {
				expect(names.has(position), `${person.firstName}: ${position}`).toBe(
					true,
				)
			}
			if (person.email) expect(person.email.endsWith('@example.com')).toBe(true)
			if (person.phone) expect(person.phone.startsWith('+1415555')).toBe(true)
		}
		const phones = DEMO_STAFF.flatMap((person) =>
			person.phone ? [person.phone] : [],
		)
		const emails = DEMO_STAFF.flatMap((person) =>
			person.email ? [person.email] : [],
		)
		expect(new Set(phones).size).toBe(phones.length)
		expect(new Set(emails).size).toBe(emails.length)
	})

	it('carries no links or domains', () => {
		const text = JSON.stringify([DEMO_POSITIONS, DEMO_STAFF]).toLowerCase()
		expect(text).not.toMatch(/https?:|www\./)
		// Demo emails use reserved example domains only.
		for (const person of DEMO_STAFF) {
			if (person.email) expect(person.email).toMatch(/@example\.(com|org|net)$/)
		}
	})
})
