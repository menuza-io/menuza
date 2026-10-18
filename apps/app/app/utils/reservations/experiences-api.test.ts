import { describe, expect, it } from 'vitest'
import {
	EXPERIENCE_KINDS,
	EXPERIENCE_STATUSES,
	parseExperiencesList,
} from './experiences-api.ts'

const row = (over: Record<string, unknown> = {}) => ({
	id: 'e1',
	locationId: 'l1',
	slug: 's',
	kind: 'ticketed',
	nameI18n: { en: 'X' },
	descriptionI18n: null,
	imageUrl: null,
	priceMinor: null,
	pricePerCover: true,
	currency: 'USD',
	policyId: null,
	partyMin: 1,
	partyMax: 4,
	usesTables: true,
	exclusive: false,
	status: 'draft',
	sort: 0,
	version: 1,
	schedules: [],
	...over,
})

describe('parseExperiencesList', () => {
	it('keeps good rows and counts the bad ones', () => {
		const out = parseExperiencesList([
			row(),
			row({ id: 'bad', kind: 'tasting' }),
			row({ id: 'e2' }),
		])
		expect(out.experiences.map((e) => e.id)).toEqual(['e1', 'e2'])
		expect(out.invalidCount).toBe(1)
	})

	it('treats a missing list as empty and a non-list as malformed', () => {
		expect(parseExperiencesList(undefined)).toEqual({
			experiences: [],
			invalidCount: 0,
		})
		expect(() => parseExperiencesList({})).toThrow()
	})

	it('shares its value lists with the setup schema', () => {
		expect([...EXPERIENCE_KINDS]).toEqual(['ticketed', 'prix_fixe'])
		expect(EXPERIENCE_STATUSES).toContain('archived')
	})
})
