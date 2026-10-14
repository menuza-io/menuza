import {
	STAFFING_PERMISSIONS as P,
	STAFFING_TOKEN_AUDIENCE,
} from '@repo/staffing'
import { jwtVerify } from 'jose'
import { ENV } from 'varlock/env'
import { describe, expect, it } from 'vitest'
import {
	grantStrings,
	mintStaffingToken,
	selectGrantsForScope,
} from './token.server.ts'

const ALL_STAFF = [
	P.READ_STAFF,
	P.UPDATE_STAFF,
	P.READ_STAFF_PAY,
	P.UPDATE_STAFF_PAY,
	P.READ_STAFF_PRIVATE,
	P.UPDATE_STAFF_PRIVATE,
]

describe('selectGrantsForScope', () => {
	it('keeps only held grants that belong to the workplace', () => {
		const held = [...ALL_STAFF, P.READ_SCHEDULE, P.READ_LABOR, P.READ_HIRING]
		expect(selectGrantsForScope(held, 'staff', { labor: true })).toEqual(
			ALL_STAFF,
		)
		expect(selectGrantsForScope(held, 'schedule', { labor: false })).toEqual([
			P.READ_STAFF,
			P.READ_SCHEDULE,
		])
		expect(selectGrantsForScope(held, 'hiring', { labor: false })).toEqual([
			P.READ_STAFF,
			P.READ_HIRING,
		])
	})

	it('never carries pay or private grants outside the staff workplace, except timesheet pay behind the labor flag', () => {
		for (const scope of ['schedule', 'hiring'] as const) {
			const grants = selectGrantsForScope(new Set(ALL_STAFF), scope, {
				labor: true,
			})
			expect(grants).not.toContain(P.READ_STAFF_PAY)
			expect(grants).not.toContain(P.UPDATE_STAFF_PAY)
			expect(grants).not.toContain(P.READ_STAFF_PRIVATE)
			expect(grants).not.toContain(P.UPDATE_STAFF_PRIVATE)
		}
		// Time clock: private data and pay edits never; the pay read only with
		// the labor flag, so a default-off org mints no wage-bearing token.
		for (const labor of [false, true]) {
			const grants = selectGrantsForScope(new Set(ALL_STAFF), 'timeclock', {
				labor,
			})
			expect(grants).not.toContain(P.UPDATE_STAFF_PAY)
			expect(grants).not.toContain(P.READ_STAFF_PRIVATE)
			expect(grants).not.toContain(P.UPDATE_STAFF_PRIVATE)
			expect(grants.includes(P.READ_STAFF_PAY)).toBe(labor)
		}
	})

	it('includes the labor grant only when the labor flag is on', () => {
		const held = [P.READ_SCHEDULE, P.READ_LABOR]
		expect(selectGrantsForScope(held, 'schedule', { labor: false })).toEqual([
			P.READ_SCHEDULE,
		])
		expect(selectGrantsForScope(held, 'schedule', { labor: true })).toEqual([
			P.READ_SCHEDULE,
			P.READ_LABOR,
		])
		// Never in the staff scope.
		expect(
			selectGrantsForScope([P.READ_LABOR], 'staff', { labor: true }),
		).toEqual([])
	})

	it('gives the labor workplace wages and tips only while the labor flag is on, and never private data or pay edits', () => {
		const held = [
			...ALL_STAFF,
			P.READ_LABOR,
			P.READ_TIMESHEET,
			P.UPDATE_TIMESHEET,
			P.UPDATE_LABOR_POLICY,
			P.READ_SCHEDULE,
		]
		const on = selectGrantsForScope(held, 'labor', { labor: true })
		expect(on).toEqual([
			P.READ_STAFF,
			P.READ_TIMESHEET,
			P.UPDATE_TIMESHEET,
			P.UPDATE_LABOR_POLICY,
			P.READ_LABOR,
			P.READ_STAFF_PAY,
		])
		for (const grant of [
			P.UPDATE_STAFF,
			P.UPDATE_STAFF_PAY,
			P.READ_STAFF_PRIVATE,
			P.UPDATE_STAFF_PRIVATE,
			P.READ_SCHEDULE,
		]) {
			expect(on).not.toContain(grant)
		}
		const off = selectGrantsForScope(held, 'labor', { labor: false })
		expect(off).not.toContain(P.READ_LABOR)
		expect(off).not.toContain(P.READ_STAFF_PAY)
	})

	it('ignores unknown permission strings', () => {
		expect(
			selectGrantsForScope(['delete:everything:any', P.READ_STAFF], 'staff', {
				labor: false,
			}),
		).toEqual([P.READ_STAFF])
	})
})

describe('grantStrings', () => {
	it('formats permission rows', () => {
		expect(
			grantStrings([{ action: 'read', entity: 'staff', access: 'any' }]),
		).toEqual(['read:staff:any'])
	})
})

describe('mintStaffingToken', () => {
	const base = {
		organizationId: 'org-1',
		userId: 'user-1',
		dataRegion: 'us',
		scope: 'staff' as const,
		scopeIds: null,
		impersonated: false,
		nowSeconds: 1_800_000_000,
	}

	async function decode(jwt: string, nowSeconds = base.nowSeconds) {
		return jwtVerify(jwt, new TextEncoder().encode(ENV.TENANT_OPERATOR_TOKEN), {
			audience: STAFFING_TOKEN_AUDIENCE,
			algorithms: ['HS256'],
			currentDate: new Date(nowSeconds * 1000),
		})
	}

	it('signs the claims tenant-api expects, with the 15 minute default life', async () => {
		const token = await mintStaffingToken({ ...base, grants: [P.READ_STAFF] })
		const { payload, protectedHeader } = await decode(token.jwt)
		expect(protectedHeader).toMatchObject({ alg: 'HS256', typ: 'staff+jwt' })
		expect(payload).toMatchObject({
			orgId: 'org-1',
			sub: 'user-1',
			role: 'operator',
			scope: 'staff',
			region: 'us',
			grants: [P.READ_STAFF],
			scopeIds: null,
			impersonated: false,
			iat: base.nowSeconds,
			exp: base.nowSeconds + 900,
		})
		expect(token.ttlSeconds).toBe(900)
		expect(token.expiresAt).toBe((base.nowSeconds + 900) * 1000)
	})

	it('shortens the life to 5 minutes for pay or private grants', async () => {
		for (const grant of [
			P.READ_STAFF_PAY,
			P.UPDATE_STAFF_PAY,
			P.READ_STAFF_PRIVATE,
			P.UPDATE_STAFF_PRIVATE,
		]) {
			const token = await mintStaffingToken({
				...base,
				grants: [P.READ_STAFF, grant],
			})
			expect(token.ttlSeconds).toBe(300)
		}
	})

	it('strips write, pay and private grants for an impersonated session', async () => {
		const token = await mintStaffingToken({
			...base,
			grants: ALL_STAFF,
			impersonated: true,
		})
		expect(token.grants).toEqual([P.READ_STAFF])
		const { payload } = await decode(token.jwt)
		expect(payload.impersonated).toBe(true)
		expect(payload.grants).toEqual([P.READ_STAFF])
		expect(token.ttlSeconds).toBeLessThanOrEqual(300)
	})

	it('targets the KSA node for KSA organizations and the US node otherwise', async () => {
		const ksa = await mintStaffingToken({
			...base,
			dataRegion: 'ksa',
			grants: [P.READ_STAFF],
		})
		expect((await decode(ksa.jwt)).payload.region).toBe('ksa')
		expect(ksa.tenantApiUrl).toMatch(/3009|ksa/i)
		for (const region of ['us', null, undefined, 'KSA ', 'eu']) {
			const token = await mintStaffingToken({
				...base,
				dataRegion: region,
				grants: [P.READ_STAFF],
			})
			const claim = (await decode(token.jwt)).payload.region
			expect(['us', 'ksa']).toContain(claim)
		}
		const us = await mintStaffingToken({
			...base,
			dataRegion: null,
			grants: [P.READ_STAFF],
		})
		expect((await decode(us.jwt)).payload.region).toBe('us')
	})

	it('carries the workplace restriction through', async () => {
		const token = await mintStaffingToken({
			...base,
			grants: [P.READ_STAFF],
			scopeIds: ['loc-1', 'loc-2'],
		})
		expect((await decode(token.jwt)).payload.scopeIds).toEqual([
			'loc-1',
			'loc-2',
		])
		const none = await mintStaffingToken({
			...base,
			grants: [P.READ_STAFF],
			scopeIds: [],
		})
		expect((await decode(none.jwt)).payload.scopeIds).toEqual([])
	})

	it('expires on schedule', async () => {
		const token = await mintStaffingToken({ ...base, grants: [P.READ_STAFF] })
		await expect(decode(token.jwt, base.nowSeconds + 901)).rejects.toThrow()
		await expect(decode(token.jwt, base.nowSeconds + 899)).resolves.toBeTruthy()
	})

	it('refuses to sign a grant tenant-api would reject', async () => {
		await expect(
			mintStaffingToken({ ...base, grants: ['update:member:any' as never] }),
		).rejects.toThrow()
	})
})
