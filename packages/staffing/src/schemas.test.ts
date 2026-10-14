import { describe, expect, it } from 'vitest'
import {
	currencySchema,
	e164PhoneSchema,
	isValidTimeZone,
	localDateSchema,
	positionInputSchema,
	staffJobInputSchema,
	staffMemberInputSchema,
	staffingTokenClaimsSchema,
	timeZoneSchema,
} from './schemas.ts'

describe('primitive schemas', () => {
	it('validates real calendar dates only', () => {
		expect(localDateSchema.safeParse('2026-02-28').success).toBe(true)
		expect(localDateSchema.safeParse('2028-02-29').success).toBe(true)
		expect(localDateSchema.safeParse('2026-02-29').success).toBe(false)
		expect(localDateSchema.safeParse('2026-13-01').success).toBe(false)
		expect(localDateSchema.safeParse('26-1-1').success).toBe(false)
		expect(localDateSchema.safeParse('2026-06-10T00:00').success).toBe(false)
	})
	it('validates IANA time zones', () => {
		expect(timeZoneSchema.safeParse('Asia/Riyadh').success).toBe(true)
		expect(timeZoneSchema.safeParse('America/Toronto').success).toBe(true)
		expect(timeZoneSchema.safeParse('Mars/Olympus').success).toBe(false)
		expect(isValidTimeZone('')).toBe(false)
	})
	it('validates E.164 numbers', () => {
		expect(e164PhoneSchema.safeParse('+966512345678').success).toBe(true)
		expect(e164PhoneSchema.safeParse('+14155550123').success).toBe(true)
		expect(e164PhoneSchema.safeParse('4155550123').success).toBe(false)
		expect(e164PhoneSchema.safeParse('+0123456789').success).toBe(false)
		expect(e164PhoneSchema.safeParse('+1 415 555 0123').success).toBe(false)
	})
	it('supports only the markets staffing prices in', () => {
		expect(currencySchema.safeParse('SAR').success).toBe(true)
		expect(currencySchema.safeParse('EUR').success).toBe(false)
	})
})

describe('staffMemberInputSchema', () => {
	it('needs no login, email, or phone', () => {
		const parsed = staffMemberInputSchema.parse({
			firstName: ' Maria ',
			lastName: 'Lopez',
		})
		expect(parsed).toMatchObject({
			firstName: 'Maria',
			workerType: 'employee',
			locale: 'en',
		})
	})
	it('lowercases email and rejects bad contact data', () => {
		expect(
			staffMemberInputSchema.parse({
				firstName: 'A',
				lastName: 'B',
				email: 'MARIA@Example.com',
			}).email,
		).toBe('maria@example.com')
		expect(
			staffMemberInputSchema.safeParse({
				firstName: 'A',
				lastName: 'B',
				email: 'nope',
			}).success,
		).toBe(false)
		expect(
			staffMemberInputSchema.safeParse({ firstName: '', lastName: 'B' })
				.success,
		).toBe(false)
		expect(
			staffMemberInputSchema.safeParse({
				firstName: 'x'.repeat(81),
				lastName: 'B',
			}).success,
		).toBe(false)
	})
})

describe('positionInputSchema', () => {
	it('stores a color token key and refuses raw hex', () => {
		expect(positionInputSchema.parse({ name: 'Associate' }).colorKey).toBe(
			'neutral',
		)
		expect(
			positionInputSchema.safeParse({ name: 'Associate', colorKey: '#ff0000' })
				.success,
		).toBe(false)
		expect(
			positionInputSchema.safeParse({ name: 'Associate', colorKey: 'blue' })
				.success,
		).toBe(true)
	})
	it('rejects fractional or negative money', () => {
		expect(
			positionInputSchema.safeParse({
				name: 'Technician',
				defaultRateMinor: 15.5,
			}).success,
		).toBe(false)
		expect(
			positionInputSchema.safeParse({
				name: 'Technician',
				defaultRateMinor: -1,
			}).success,
		).toBe(false)
	})
})

describe('staffJobInputSchema', () => {
	const base = {
		scopeId: 'loc',
		positionId: 'pos',
		payType: 'hourly',
		rateMinor: 1800,
		currency: 'USD',
		effectiveFrom: '2026-06-01',
	}
	it('accepts an hourly job and defaults the rest', () => {
		expect(staffJobInputSchema.parse(base)).toMatchObject({
			effectiveTo: null,
			overtimeExempt: false,
		})
	})
	it('rejects an end date before the start date', () => {
		expect(
			staffJobInputSchema.safeParse({ ...base, effectiveTo: '2026-05-31' })
				.success,
		).toBe(false)
		expect(
			staffJobInputSchema.safeParse({ ...base, effectiveTo: '2026-06-01' })
				.success,
		).toBe(true)
	})
	it('requires an annual salary for salary jobs', () => {
		expect(
			staffJobInputSchema.safeParse({ ...base, payType: 'salary' }).success,
		).toBe(false)
		expect(
			staffJobInputSchema.safeParse({
				...base,
				payType: 'salary',
				annualSalaryMinor: 5_000_000,
			}).success,
		).toBe(true)
	})
})

describe('staffingTokenClaimsSchema', () => {
	const claims = {
		aud: 'tenant-api-staff-operator',
		role: 'operator',
		orgId: 'org1',
		sub: 'user1',
		scope: 'staff',
		grants: ['read:staff:any'],
		scopeIds: null,
	}
	it('accepts a valid claim set', () => {
		expect(staffingTokenClaimsSchema.parse(claims)).toMatchObject({
			impersonated: false,
		})
	})
	it('rejects unknown grants, scopes, and audiences', () => {
		expect(
			staffingTokenClaimsSchema.safeParse({
				...claims,
				grants: ['update:member:any'],
			}).success,
		).toBe(false)
		expect(
			staffingTokenClaimsSchema.safeParse({ ...claims, scope: 'admin' })
				.success,
		).toBe(false)
		expect(
			staffingTokenClaimsSchema.safeParse({
				...claims,
				aud: 'tenant-api-operator',
			}).success,
		).toBe(false)
		expect(
			staffingTokenClaimsSchema.safeParse({ ...claims, orgId: '' }).success,
		).toBe(false)
	})
})
