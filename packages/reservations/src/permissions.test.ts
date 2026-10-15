import { describe, expect, it } from 'vitest'
import {
	IMPLIED_READ_BY_UPDATE,
	RESERVATIONS_PERMISSION_LIST,
	RESERVATIONS_PERMISSIONS,
	RESERVATIONS_ROLE_PRESETS,
	SENSITIVE_GRANTS,
	grantsSatisfying,
	hasSensitiveGrant,
	isSensitiveGrant,
	restrictGrantsForImpersonation,
} from './permissions.ts'
import {
	RESERVATIONS_SCOPES,
	RESERVATIONS_TOKEN_AUDIENCE,
	RESERVATIONS_TOKEN_MAX_TTL_SECONDS,
	RESERVATIONS_TOKEN_SENSITIVE_TTL_SECONDS,
	RESERVATIONS_TOKEN_TYP,
	SCOPE_GRANTS,
	maxTokenTtlSeconds,
	reservationsTokenClaimsSchema,
	scopeGrantsFor,
} from './token.ts'

describe('reservations permissions and token claims', () => {
	it('exports the 8 reservations permissions and sensitive grants', () => {
		expect(RESERVATIONS_PERMISSIONS).toEqual({
			READ_RESERVATION: 'read:reservation:any',
			UPDATE_RESERVATION: 'update:reservation:any',
			READ_RESERVATION_SETTINGS: 'read:reservation_settings:any',
			UPDATE_RESERVATION_SETTINGS: 'update:reservation_settings:any',
			READ_RESERVATION_GUEST: 'read:reservation_guest:any',
			UPDATE_RESERVATION_GUEST: 'update:reservation_guest:any',
			READ_RESERVATION_REPORT: 'read:reservation_report:any',
			UPDATE_RESERVATION_PAYMENT: 'update:reservation_payment:any',
		})
		expect(RESERVATIONS_PERMISSION_LIST).toHaveLength(8)
		expect(SENSITIVE_GRANTS).toEqual([
			'read:reservation_guest:any',
			'update:reservation_guest:any',
			'update:reservation_payment:any',
		])
		expect(isSensitiveGrant('read:reservation_guest:any')).toBe(true)
		expect(isSensitiveGrant('read:reservation:any')).toBe(false)
		expect(
			hasSensitiveGrant([
				'read:reservation:any',
				'update:reservation_payment:any',
			]),
		).toBe(true)
		expect(hasSensitiveGrant(['read:reservation:any'])).toBe(false)
	})

	it('expands update grants to imply matching read grants via grantsSatisfying', () => {
		expect(IMPLIED_READ_BY_UPDATE['update:reservation:any']).toBe(
			'read:reservation:any',
		)
		expect(IMPLIED_READ_BY_UPDATE['update:reservation_settings:any']).toBe(
			'read:reservation_settings:any',
		)
		expect(IMPLIED_READ_BY_UPDATE['update:reservation_guest:any']).toBe(
			'read:reservation_guest:any',
		)
		expect(grantsSatisfying('read:reservation:any')).toEqual([
			'read:reservation:any',
			'update:reservation:any',
		])
		expect(grantsSatisfying('read:reservation_settings:any')).toEqual([
			'read:reservation_settings:any',
			'update:reservation_settings:any',
		])
		expect(grantsSatisfying('read:reservation_guest:any')).toEqual([
			'read:reservation_guest:any',
			'update:reservation_guest:any',
		])
		expect(grantsSatisfying('update:reservation_payment:any')).toEqual([
			'update:reservation_payment:any',
		])
	})

	it('strips write and sensitive grants when impersonating', () => {
		const all = [...RESERVATIONS_PERMISSION_LIST]
		expect(restrictGrantsForImpersonation(all, false)).toEqual(all)
		expect(restrictGrantsForImpersonation(all, true)).toEqual([
			'read:reservation:any',
			'read:reservation_settings:any',
			'read:reservation_report:any',
		])
	})

	it('defines role presets and scope grants', () => {
		expect(RESERVATIONS_ROLE_PRESETS.host.permissions).toEqual([
			'read:reservation:any',
			'update:reservation:any',
		])
		expect(RESERVATIONS_ROLE_PRESETS.owner.permissions).toHaveLength(8)

		expect(RESERVATIONS_SCOPES).toEqual([
			'book',
			'guests',
			'setup',
			'reports',
			'payments',
		])
		expect(SCOPE_GRANTS).toEqual({
			book: ['read:reservation:any', 'update:reservation:any'],
			guests: [
				'read:reservation:any',
				'read:reservation_guest:any',
				'update:reservation_guest:any',
			],
			setup: [
				'read:reservation_settings:any',
				'update:reservation_settings:any',
			],
			reports: ['read:reservation_report:any'],
			payments: ['read:reservation:any', 'update:reservation_payment:any'],
		})

		expect(scopeGrantsFor('book', ['update:reservation:any'], false)).toEqual([
			'read:reservation:any',
			'update:reservation:any',
		])
		expect(
			scopeGrantsFor('guests', ['update:reservation_guest:any'], true),
		).toEqual([])
	})

	it('validates operator token claims and TTL rules (900s standard, 300s sensitive/impersonated)', () => {
		expect(RESERVATIONS_TOKEN_AUDIENCE).toBe('tenant-api-reservations-operator')
		expect(RESERVATIONS_TOKEN_TYP).toBe('rsv+jwt')
		expect(RESERVATIONS_TOKEN_MAX_TTL_SECONDS).toBe(900)
		expect(RESERVATIONS_TOKEN_SENSITIVE_TTL_SECONDS).toBe(300)

		expect(maxTokenTtlSeconds(['read:reservation:any'], false)).toBe(900)
		expect(maxTokenTtlSeconds(['read:reservation_guest:any'], false)).toBe(300)
		expect(maxTokenTtlSeconds(['read:reservation:any'], true)).toBe(300)

		const validBook = reservationsTokenClaimsSchema.safeParse({
			aud: 'tenant-api-reservations-operator',
			role: 'operator',
			region: 'us',
			orgId: 'org_acme',
			sub: 'user_kody',
			scope: 'book',
			grants: ['read:reservation:any', 'update:reservation:any'],
			locationIds: null,
			features: {
				enabled: true,
				online: true,
				waitlist: true,
				payments: false,
				experiences: false,
				voice: false,
			},
			impersonated: false,
			iat: 1_700_000_000,
			exp: 1_700_000_900,
		})
		expect(validBook.success).toBe(true)

		// Rejects 900s TTL when sensitive grant is present
		const overLongSensitive = reservationsTokenClaimsSchema.safeParse({
			aud: 'tenant-api-reservations-operator',
			role: 'operator',
			region: 'us',
			orgId: 'org_acme',
			sub: 'user_kody',
			scope: 'guests',
			grants: ['read:reservation:any', 'read:reservation_guest:any'],
			locationIds: ['loc_1'],
			features: {
				enabled: true,
				online: true,
				waitlist: true,
				payments: false,
				experiences: false,
				voice: false,
			},
			impersonated: false,
			iat: 1_700_000_000,
			exp: 1_700_000_900,
		})
		expect(overLongSensitive.success).toBe(false)

		// Rejects write or sensitive grants when impersonated
		const impersonatedWrite = reservationsTokenClaimsSchema.safeParse({
			aud: 'tenant-api-reservations-operator',
			role: 'operator',
			region: 'ksa',
			orgId: 'org_riyadh',
			sub: 'user_admin',
			scope: 'book',
			grants: ['read:reservation:any', 'update:reservation:any'],
			locationIds: null,
			features: {
				enabled: true,
				online: false,
				waitlist: false,
				payments: false,
				experiences: false,
				voice: false,
			},
			impersonated: true,
			iat: 1_700_000_000,
			exp: 1_700_000_300,
		})
		expect(impersonatedWrite.success).toBe(false)
	})
})
