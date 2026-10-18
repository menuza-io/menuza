import { describe, expect, it } from 'vitest'
import {
	setupExperienceInputSchema,
	setupExperienceScheduleInputSchema,
	setupExperienceUpdateSchema,
} from './experience-setup.ts'

const valid = {
	slug: 'chefs-counter',
	nameI18n: { en: "Chef's Counter" },
	priceMinor: 7500,
	partyMin: 2,
	partyMax: 6,
}

function issuePaths(result: {
	success: boolean
	error?: { issues: Array<{ path: PropertyKey[] }> }
}) {
	return result.error?.issues.map((i) => i.path.join('.')) ?? []
}

describe('setupExperienceInputSchema', () => {
	it('accepts a minimal definition and fills defaults', () => {
		const parsed = setupExperienceInputSchema.parse(valid)
		expect(parsed).toMatchObject({
			kind: 'ticketed',
			usesTables: true,
			exclusive: false,
			pricePerCover: true,
		})
	})
	it.each([
		['party range inverted', { partyMin: 6, partyMax: 2 }, 'partyMin'],
		['negative price', { priceMinor: -1 }, 'priceMinor'],
		['slug alphabet', { slug: 'Bad Slug!' }, 'slug'],
		['slug too long', { slug: 'a'.repeat(65) }, 'slug'],
		['party out of range', { partyMax: 100 }, 'partyMax'],
		['http image', { imageUrl: 'http://x.test/a.png' }, 'imageUrl'],
		['javascript image', { imageUrl: 'javascript:alert(1)' }, 'imageUrl'],
		['unknown locale', { nameI18n: { en: 'x', xx: 'y' } }, 'nameI18n'],
		['client currency', { currency: 'EUR' }, ''],
	])('rejects %s', (_label, patch, path) => {
		const result = setupExperienceInputSchema.safeParse({ ...valid, ...patch })
		expect(result.success).toBe(false)
		expect(issuePaths(result)).toContain(path)
	})
	it('requires a non-empty name in some locale', () => {
		expect(
			setupExperienceInputSchema.safeParse({ ...valid, nameI18n: {} }).success,
		).toBe(false)
	})
})

describe('setupExperienceUpdateSchema', () => {
	it('requires expectedVersion and allows a partial patch', () => {
		expect(setupExperienceUpdateSchema.safeParse({ partyMax: 4 }).success).toBe(
			false,
		)
		expect(
			setupExperienceUpdateSchema.safeParse({ partyMax: 4, expectedVersion: 1 })
				.success,
		).toBe(true)
	})
})

describe('setupExperienceScheduleInputSchema', () => {
	const base = {
		fromDate: '2030-01-05',
		toDate: '2030-01-05',
		seatingMins: [1140],
	}
	it('accepts explicit and stepped seatings', () => {
		expect(setupExperienceScheduleInputSchema.safeParse(base).success).toBe(
			true,
		)
		expect(
			setupExperienceScheduleInputSchema.safeParse({
				fromDate: '2030-01-05',
				toDate: '2030-01-06',
				startMin: 1080,
				endMin: 1260,
				intervalMin: 60,
			}).success,
		).toBe(true)
	})
	it.each([
		[
			'end before start',
			{ seatingMins: undefined, startMin: 1200, endMin: 1100, intervalMin: 30 },
			'endMin',
		],
		[
			'end equals start',
			{ seatingMins: undefined, startMin: 1200, endMin: 1200, intervalMin: 30 },
			'endMin',
		],
		['no seatings', { seatingMins: undefined }, 'seatingMins'],
		['both modes', { startMin: 1, endMin: 5, intervalMin: 1 }, 'seatingMins'],
		['date order', { toDate: '2030-01-01' }, 'toDate'],
		['minute out of range', { seatingMins: [2881] }, 'seatingMins.0'],
		['zero cap', { coversCapPerSeating: 0 }, 'coversCapPerSeating'],
		['negative cap', { coversCapPerDay: -3 }, 'coversCapPerDay'],
		['mask zero', { daysMask: 0 }, 'daysMask'],
	])('rejects %s', (_label, patch, path) => {
		const result = setupExperienceScheduleInputSchema.safeParse({
			...base,
			...patch,
		})
		expect(result.success).toBe(false)
		expect(issuePaths(result)).toContain(path)
	})
})
