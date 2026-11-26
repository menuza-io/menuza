import {
	buildCateringQnA,
	defaultCateringSettings,
	type CateringSettings,
} from '@repo/common/catering'
import { FaqEntrySchema } from '@repo/phone-agent'
import { describe, expect, it } from 'vitest'
import { cateringKnowledge } from './phone-agent-knowledge.ts'

const facts = {
	currency: 'USD',
	deliveryZoneNames: ['Downtown'],
	deliveryFeeMinor: 1500,
}
const base = {
	facts,
	locationId: 'loc-1',
	timeZone: 'America/New_York',
	locale: 'en',
	defaultLocale: 'en',
	now: new Date('2026-06-01T16:00:00Z'),
}
const settings = (patch: Partial<CateringSettings> = {}): CateringSettings => ({
	...defaultCateringSettings(),
	enabled: true,
	...patch,
})

describe('catering knowledge for the phone agent (#325, #255)', () => {
	it('gives the agent the same answers the catering page shows (325-2)', () => {
		const s = settings({
			noticeHours: 48,
			minMinor: 25_000,
			questions: {
				standard: { cutlery: { en: 'Yes, plates and cutlery are included.' } },
				custom: [],
			},
		})
		const page = buildCateringQnA(s, {
			locale: 'en',
			defaultLocale: 'en',
			facts,
		})
		const agent = cateringKnowledge({ ...base, settings: s })
		expect(agent.map((e) => e.answer)).toEqual(page.map((e) => e.answer))
		expect(agent.map((e) => e.question)).toEqual(page.map((e) => e.question))
		// Every entry is a valid FAQ entry scoped to the location.
		for (const entry of agent) {
			expect(FaqEntrySchema.safeParse(entry).success).toBe(true)
			expect(entry.scopeId).toBe('loc-1')
		}
	})

	it('follows a changed minimum notice on the next call (325-3)', () => {
		const answer = (hours: number) =>
			cateringKnowledge({
				...base,
				settings: settings({ noticeHours: hours }),
			}).find((e) => e.id === 'catering_notice')?.answer
		expect(answer(48)).toContain('48 hours')
		expect(answer(72)).toContain('72 hours')
	})

	it('says which holiday dates are still open and which have closed (255-1 for the phone agent)', () => {
		const s = settings({
			cutoffs: [
				{
					id: 'a',
					from: '2026-12-20',
					to: '2026-12-24',
					orderByDate: '2026-12-10',
					orderByTime: '17:00',
				},
				{
					id: 'b',
					from: '2026-06-04',
					to: '2026-06-05',
					orderByDate: '2026-05-30',
					orderByTime: '09:00',
				},
			],
		})
		const entry = cateringKnowledge({ ...base, settings: s }).find(
			(e) => e.id === 'catering_cutoffs',
		)!
		expect(entry.answer).toContain(
			'Dec 20, 2026 to Dec 24, 2026: order by Dec 10, 2026',
		)
		expect(entry.answer).toContain('is closed')
	})

	it('gives nothing while catering is off', () => {
		expect(
			cateringKnowledge({ ...base, settings: settings({ enabled: false }) }),
		).toEqual([])
	})
})
