import { type MessageDescriptor } from '@lingui/core'
import { describe, expect, it } from 'vitest'
import { type ExperienceDto } from '#app/utils/reservations/experiences-api.ts'
import {
	conflictCurrent,
	daysToMask,
	emptyExperienceForm,
	emptyScheduleForm,
	experienceErrorMessages,
	experienceFormToInput,
	experiencePatch,
	experienceToForm,
	experienceToInput,
	formatCalendarDate,
	formatSeatingMin,
	maskToDays,
	pickExperienceText,
	scheduleFormToBody,
	scheduleToForm,
	seatingSummary,
	slugify,
} from '#app/utils/reservations/experiences-view.ts'

const experience: ExperienceDto = {
	id: 'exp_1',
	locationId: 'loc_1',
	slug: 'chefs-counter',
	kind: 'ticketed',
	nameI18n: { en: "Chef's Counter", ar: 'مائدة الشيف' },
	descriptionI18n: { en: 'Eight courses.' },
	imageUrl: 'https://cdn.example.com/a.jpg',
	priceMinor: 7500,
	pricePerCover: true,
	currency: 'USD',
	policyId: 'pol_1',
	partyMin: 2,
	partyMax: 4,
	usesTables: true,
	exclusive: false,
	status: 'draft',
	sort: 3,
	version: 6,
	schedules: [],
}

describe('slugify', () => {
	it('makes a link name from an English name and nothing from Arabic', () => {
		expect(slugify("Chef's Counter!")).toBe('chefs-counter')
		expect(slugify('  Café   Menu  ')).toBe('cafe-menu')
		expect(slugify('مائدة الشيف')).toBe('')
	})
})

describe('pickExperienceText', () => {
	it('prefers the interface language, then English, then any', () => {
		expect(pickExperienceText({ en: 'A', ar: 'ب' }, 'ar')).toBe('ب')
		expect(pickExperienceText({ en: 'A', ar: 'ب' }, 'fr')).toBe('A')
		expect(pickExperienceText({ zh: '菜单' }, 'en')).toBe('菜单')
		expect(pickExperienceText(null, 'en')).toBe('')
	})
})

describe('experienceFormToInput', () => {
	const form = {
		...emptyExperienceForm(),
		slug: 'chefs-counter',
		names: { en: ' Chef Counter ', ar: '' },
		price: '75',
	}

	it('builds a full input with integer minor units and trimmed copy', () => {
		expect(experienceFormToInput(form, 'USD')).toEqual({
			ok: true,
			input: {
				slug: 'chefs-counter',
				kind: 'ticketed',
				nameI18n: { en: 'Chef Counter' },
				descriptionI18n: null,
				imageUrl: null,
				priceMinor: 7500,
				pricePerCover: true,
				policyId: null,
				partyMin: 1,
				partyMax: 8,
				usesTables: true,
				exclusive: false,
				sort: 0,
			},
		})
	})

	it('flags a missing name, a bad link name, a bad price and an insecure image', () => {
		const result = experienceFormToInput(
			{
				...form,
				names: {},
				slug: 'Has Spaces',
				price: '7.555',
				imageUrl: 'http://cdn.example.com/a.jpg',
			},
			'USD',
		)
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(Object.keys(result.errors).sort()).toEqual([
				'imageUrl',
				'name',
				'price',
				'slug',
			])
		}
	})

	it('checks the party range', () => {
		const result = experienceFormToInput(
			{ ...form, partyMin: '6', partyMax: '4' },
			'USD',
		)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.errors.partyMax).toBeTruthy()
		expect(experienceFormToInput({ ...form, partyMax: '100' }, 'USD').ok).toBe(
			false,
		)
	})

	it('uses the currency decimals', () => {
		const sar = experienceFormToInput({ ...form, price: '250.00' }, 'SAR')
		expect(sar.ok && sar.input.priceMinor).toBe(25000)
	})
})

describe('experiencePatch', () => {
	it('round-trips a saved experience to no change', () => {
		const parsed = experienceFormToInput(experienceToForm(experience), 'USD')
		expect(parsed.ok).toBe(true)
		if (parsed.ok) {
			expect(parsed.input).toEqual(experienceToInput(experience))
			expect(experiencePatch(experience, parsed.input, 6)).toBeNull()
		}
	})

	it('sends only what changed with the latest version', () => {
		const form = {
			...experienceToForm(experience),
			price: '80',
			exclusive: true,
		}
		const parsed = experienceFormToInput(form, 'USD')
		if (!parsed.ok) throw new Error('form should parse')
		expect(experiencePatch(experience, parsed.input, 9)).toEqual({
			priceMinor: 8000,
			exclusive: true,
			expectedVersion: 9,
		})
	})

	it('sends a cleared price, policy and image as null', () => {
		const form = {
			...experienceToForm(experience),
			price: '',
			policyId: '',
			imageUrl: '',
		}
		const parsed = experienceFormToInput(form, 'USD')
		if (!parsed.ok) throw new Error('form should parse')
		expect(experiencePatch(experience, parsed.input, 6)).toEqual({
			priceMinor: null,
			policyId: null,
			imageUrl: null,
			expectedVersion: 6,
		})
	})
})

describe('weekdays', () => {
	it('uses the schedule mask: bit 0 is Monday, bit 6 is Sunday', () => {
		expect(daysToMask([true, false, false, false, false, false, false])).toBe(1)
		expect(daysToMask([false, false, false, false, false, true, false])).toBe(
			32,
		)
		expect(maskToDays(64)).toEqual([
			false,
			false,
			false,
			false,
			false,
			false,
			true,
		])
		expect(maskToDays(127).every(Boolean)).toBe(true)
	})
})

describe('scheduleFormToBody', () => {
	const base = { ...emptyScheduleForm('2026-10-24'), toDate: '2026-12-31' }

	it('needs a time, a day and sane dates', () => {
		const result = scheduleFormToBody(base, { usesTables: true })
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.errors.times).toBeTruthy()
		expect(
			scheduleFormToBody(
				{ ...base, times: ['19:00'], days: base.days.map(() => false) },
				{ usesTables: true },
			).ok,
		).toBe(false)
		const reversed = scheduleFormToBody(
			{ ...base, times: ['19:00'], toDate: '2026-10-01' },
			{ usesTables: true },
		)
		expect(reversed.ok).toBe(false)
	})

	it('turns specific times into sorted minutes and drops the interval fields', () => {
		const result = scheduleFormToBody(
			{ ...base, times: ['20:30', '19:00', '19:00'], capSeating: '8' },
			{ usesTables: true },
		)
		expect(result).toEqual({
			ok: true,
			body: {
				fromDate: '2026-10-24',
				toDate: '2026-12-31',
				daysMask: 127,
				seatingMins: [1140, 1230],
				startMin: null,
				endMin: null,
				intervalMin: null,
				turnMin: 90,
				coversCapPerSeating: 8,
				coversCapPerDay: null,
				areaIds: null,
				serviceId: null,
			},
		})
	})

	it('builds an interval schedule and refuses more than 48 seatings', () => {
		const ok = scheduleFormToBody(
			{
				...base,
				mode: 'interval',
				start: '18:00',
				end: '21:00',
				interval: '30',
			},
			{ usesTables: true },
		)
		expect(ok).toMatchObject({
			ok: true,
			body: {
				seatingMins: null,
				startMin: 1080,
				endMin: 1260,
				intervalMin: 30,
			},
		})
		const tooMany = scheduleFormToBody(
			{
				...base,
				mode: 'interval',
				start: '00:00',
				end: '23:59',
				interval: '15',
			},
			{ usesTables: true },
		)
		expect(tooMany.ok).toBe(false)
		if (!tooMany.ok) expect(tooMany.errors.interval).toBeTruthy()
		const backwards = scheduleFormToBody(
			{ ...base, mode: 'interval', start: '21:00', end: '18:00' },
			{ usesTables: true },
		)
		expect(backwards.ok).toBe(false)
	})

	it('needs a covers limit when the experience does not use tables', () => {
		const withoutCap = scheduleFormToBody(
			{ ...base, times: ['19:00'] },
			{ usesTables: false },
		)
		expect(withoutCap.ok).toBe(false)
		if (!withoutCap.ok) expect(withoutCap.errors.capSeating).toBeTruthy()
		expect(
			scheduleFormToBody(
				{ ...base, times: ['19:00'], capDay: '40' },
				{ usesTables: false },
			).ok,
		).toBe(true)
	})

	it('keeps area and service restrictions', () => {
		const result = scheduleFormToBody(
			{ ...base, times: ['19:00'], areaIds: ['bar'], serviceId: 'dinner' },
			{ usesTables: true },
		)
		expect(result).toMatchObject({
			ok: true,
			body: { areaIds: ['bar'], serviceId: 'dinner' },
		})
	})

	it('round-trips a saved schedule', () => {
		const schedule = {
			id: 's1',
			experienceId: 'exp_1',
			fromDate: '2026-10-24',
			toDate: '2026-12-31',
			daysMask: 32,
			seatingMins: [1140],
			startMin: null,
			endMin: null,
			intervalMin: null,
			turnMin: 120,
			coversCapPerSeating: 8,
			coversCapPerDay: null,
			areaIds: ['main'],
			serviceId: null,
			seatings: [1140],
		}
		const back = scheduleFormToBody(scheduleToForm(schedule), {
			usesTables: true,
		})
		expect(back).toMatchObject({
			ok: true,
			body: {
				daysMask: 32,
				seatingMins: [1140],
				turnMin: 120,
				coversCapPerSeating: 8,
				areaIds: ['main'],
			},
		})
	})
})

describe('formatting', () => {
	it('formats seating times and calendar dates in the locale without a zone shift', () => {
		expect(formatSeatingMin(1140, 'en')).toMatch(/7:00\s?PM/)
		expect(formatSeatingMin(1140, 'en-GB')).toMatch(/19:00/)
		expect(formatCalendarDate('2026-10-24', 'en')).toMatch(/Oct 24, 2026/)
	})

	it('summarizes many seatings', () => {
		const schedule = {
			seatings: [1080, 1140, 1200, 1260, 1320],
		} as never
		expect(seatingSummary(schedule, 'en-GB', 3)).toBe('18:00, 19:00, 20:00 +2')
	})
})

describe('error messages', () => {
	const translate = (descriptor: MessageDescriptor) => descriptor.message ?? ''
	const fallback = { id: 'fallback', message: 'fallback' }

	it('explains each publish problem once and never echoes server text', () => {
		const err = {
			status: 400,
			body: {
				error: 'invalid',
				issues: [
					{ path: 'schedules', code: 'schedules_required' },
					{ path: 'schedules.0.coversCapPerSeating', code: 'cap_required' },
					{ path: 'schedules.1.coversCapPerSeating', code: 'cap_required' },
				],
			},
		}
		const messages = experienceErrorMessages(err, translate, fallback)
		expect(messages).toHaveLength(2)
		expect(messages[0]).toMatch(/at least one schedule/)
		expect(messages[1]).toMatch(/covers limit/)
	})

	it('knows a taken link name and a conflict, and falls back otherwise', () => {
		expect(
			experienceErrorMessages(
				{ status: 409, body: { error: 'slug_taken' } },
				translate,
				fallback,
			)[0],
		).toMatch(/already uses this link name/)
		expect(
			experienceErrorMessages({ status: 500, body: {} }, translate, fallback),
		).toEqual(['fallback'])
	})

	it('reads the region version out of a conflict', () => {
		expect(
			conflictCurrent({
				body: { error: 'stale_version', current: { id: 'x' } },
			}),
		).toEqual({ id: 'x' })
		expect(
			conflictCurrent({ body: { error: 'other', current: { id: 'x' } } }),
		).toBeNull()
	})
})
