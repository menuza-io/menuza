import { describe, expect, it } from 'vitest'
import {
	canMoveHiringStage,
	careersApplySchema,
	declinedRetentionExpiry,
	HIRING_CONSENT_VERSION,
	HIRING_DEFAULT_RETENTION_DAYS,
	hiringHireSchema,
	hiringListQuerySchema,
	interviewCreateSchema,
	normalizeApplicantPhone,
	resolveApplicantRetentionDays,
} from './hiring-api.ts'

const valid = {
	postingSlug: 'team-lead',
	firstName: 'Sara',
	lastName: 'Ali',
	email: 'Sara@Example.com ',
	consent: true,
	consentVersion: HIRING_CONSENT_VERSION,
	answers: { weekends: 'yes' },
}

describe('careersApplySchema', () => {
	it('normalizes email and defaults locale, source and answers', () => {
		const parsed = careersApplySchema.parse(valid)
		expect(parsed.email).toBe('sara@example.com')
		expect(parsed.locale).toBe('en')
		expect(parsed.source).toBe('careers_page')
		expect(
			careersApplySchema.parse({ ...valid, answers: undefined }).answers,
		).toEqual({})
	})

	it('needs a way to reach the person and real consent', () => {
		expect(
			careersApplySchema.safeParse({ ...valid, email: undefined }).success,
		).toBe(false)
		expect(
			careersApplySchema.safeParse({ ...valid, consent: false }).success,
		).toBe(false)
		expect(
			careersApplySchema.safeParse({ ...valid, consent: 'yes' }).success,
		).toBe(false)
		expect(
			careersApplySchema.safeParse({ ...valid, consentVersion: '1999-01' })
				.success,
		).toBe(false)
	})

	it('accepts a phone typed the way people type it', () => {
		const parsed = careersApplySchema.parse({
			...valid,
			email: undefined,
			phone: '00966 (51) 234-5678',
		})
		expect(parsed.phone).toBe('+966512345678')
		expect(
			careersApplySchema.safeParse({ ...valid, phone: '0512345678' }).success,
		).toBe(false)
	})

	it('refuses unknown keys, markup in names and oversize input', () => {
		expect(
			careersApplySchema.safeParse({ ...valid, orgId: 'other' }).success,
		).toBe(false)
		expect(
			careersApplySchema.safeParse({ ...valid, stage: 'hired' }).success,
		).toBe(false)
		expect(
			careersApplySchema.safeParse({
				...valid,
				firstName: '<script>x</script>',
			}).success,
		).toBe(false)
		expect(
			careersApplySchema.safeParse({ ...valid, firstName: 'a'.repeat(81) })
				.success,
		).toBe(false)
		const many = Object.fromEntries(
			Array.from({ length: 21 }, (_, i) => [`q${i}`, 'yes']),
		)
		expect(
			careersApplySchema.safeParse({ ...valid, answers: many }).success,
		).toBe(false)
		expect(
			careersApplySchema.safeParse({ ...valid, answers: { 'bad key!': 'yes' } })
				.success,
		).toBe(false)
		expect(
			careersApplySchema.safeParse({ ...valid, postingSlug: '../etc' }).success,
		).toBe(false)
	})
})

describe('normalizeApplicantPhone', () => {
	it('keeps real international numbers and refuses the rest', () => {
		expect(normalizeApplicantPhone('+1 (415) 555-0123')).toBe('+14155550123')
		expect(normalizeApplicantPhone('555-0123')).toBeNull()
		expect(normalizeApplicantPhone('+0123456789')).toBeNull()
		expect(normalizeApplicantPhone('')).toBeNull()
	})
})

describe('stage moves', () => {
	it('moves freely between open stages, never into hired or declined', () => {
		expect(canMoveHiringStage('new', 'interview')).toBe(true)
		expect(canMoveHiringStage('offer', 'new')).toBe(true)
		expect(canMoveHiringStage('declined', 'screening')).toBe(true)
		expect(canMoveHiringStage('new', 'hired')).toBe(false)
		expect(canMoveHiringStage('new', 'declined')).toBe(false)
		expect(canMoveHiringStage('hired', 'new')).toBe(false)
		expect(canMoveHiringStage('new', 'new')).toBe(false)
	})
})

describe('retention', () => {
	it('uses the configured days or the default', () => {
		expect(resolveApplicantRetentionDays(null)).toBe(
			HIRING_DEFAULT_RETENTION_DAYS,
		)
		expect(resolveApplicantRetentionDays(0)).toBe(HIRING_DEFAULT_RETENTION_DAYS)
		expect(resolveApplicantRetentionDays(30)).toBe(30)
		expect(resolveApplicantRetentionDays(99999)).toBe(3650)
		expect(declinedRetentionExpiry(1000, 1)).toBe(1000 + 86_400_000)
	})
})

describe('operator schemas', () => {
	it('parses list filters and caps paging', () => {
		const q = hiringListQuerySchema.parse({
			flagged: '1',
			limit: '500'.slice(0, 2),
		})
		expect(q.flagged).toBe(true)
		expect(hiringListQuerySchema.parse({ stage: 'open' }).stage).toBe('open')
		expect(hiringListQuerySchema.safeParse({ limit: '1000' }).success).toBe(
			false,
		)
		expect(hiringListQuerySchema.safeParse({ stage: 'maybe' }).success).toBe(
			false,
		)
		expect(hiringListQuerySchema.safeParse({ q: 'a\u0000' }).success).toBe(
			false,
		)
	})

	it('hire needs a salary for salaried work and always names a currency', () => {
		const base = {
			scopeId: 'loc1',
			positionId: 'pos1',
			hiredDate: '2026-10-20',
			currency: 'USD',
		}
		expect(hiringHireSchema.safeParse(base).success).toBe(true)
		expect(
			hiringHireSchema.safeParse({ ...base, currency: undefined }).success,
		).toBe(false)
		expect(
			hiringHireSchema.safeParse({ ...base, payType: 'salary' }).success,
		).toBe(false)
		expect(
			hiringHireSchema.safeParse({ ...base, rateMinor: 1500 }).success,
		).toBe(true)
		expect(hiringHireSchema.safeParse({ ...base, userId: 'x' }).success).toBe(
			false,
		)
	})

	it('interviews need a sane duration', () => {
		expect(
			interviewCreateSchema.safeParse({ scheduledAt: 1, durationMinutes: 5 })
				.success,
		).toBe(false)
		expect(
			interviewCreateSchema.parse({ scheduledAt: 1 }).durationMinutes,
		).toBe(30)
	})
})
