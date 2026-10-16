import { RESERVATIONS_PERMISSIONS } from '@repo/reservations'
import { describe, expect, it } from 'vitest'
import { TENANT_ROLE_PERMISSION_IDS } from '#app/utils/organization/tenant-role-permissions.ts'
import {
	getReservationsRolePreset,
	isReservationsRolePresetKey,
	permissionIdFor,
	RESERVATIONS_GRANT_BY_PERMISSION_ID,
	RESERVATIONS_PERMISSION_ID_BY_GRANT,
	RESERVATIONS_ROLE_PRESET_KEYS,
	RESERVATIONS_ROLE_PRESETS,
} from './role-presets.ts'

describe('reservations role presets', () => {
	it('defines the reservations role presets including Host, Reservations manager, Guest relations, Owner, Shift manager, Guestbook manager, and Finance', () => {
		expect(RESERVATIONS_ROLE_PRESETS.map((preset) => preset.key)).toEqual([
			...RESERVATIONS_ROLE_PRESET_KEYS,
		])
		expect(RESERVATIONS_ROLE_PRESETS.map((preset) => preset.name)).toEqual([
			'Host',
			'Shift manager',
			'Reservations manager',
			'Guest relations',
			'Guestbook manager',
			'Finance',
			'Owner',
		])
	})

	it('maps every reservations permission string to a grantable tenant role permission id', () => {
		const allowed = new Set<string>(TENANT_ROLE_PERMISSION_IDS)
		for (const grant of Object.values(RESERVATIONS_PERMISSIONS)) {
			const id = permissionIdFor(grant)
			expect(RESERVATIONS_PERMISSION_ID_BY_GRANT[grant]).toBe(id)
			expect(RESERVATIONS_GRANT_BY_PERMISSION_ID[id]).toBe(grant)
			expect(allowed.has(id)).toBe(true)
		}
	})

	it('grants exact expected permissions for Host, Reservations manager, Guest relations, Owner, Shift manager, Guestbook manager, and Finance', () => {
		expect(getReservationsRolePreset('host').permissions).toEqual([
			'read:reservation:any',
			'update:reservation:any',
		])
		expect(
			getReservationsRolePreset('reservations_manager').permissions,
		).toHaveLength(7)
		expect(
			getReservationsRolePreset('reservations_manager').permissions,
		).not.toContain('update:reservation_payment:any')
		expect(
			getReservationsRolePreset('reservations_manager').permissionIds,
		).not.toContain('org_perm_update_reservation_payment_any')
		expect(getReservationsRolePreset('guest_relations').permissions).toEqual([
			'read:reservation:any',
			'read:reservation_guest:any',
			'update:reservation_guest:any',
		])
		expect(getReservationsRolePreset('guestbook_manager').permissions).toEqual([
			'read:reservation:any',
			'read:reservation_guest:any',
			'update:reservation_guest:any',
		])
		expect(getReservationsRolePreset('finance').permissionIds).toContain(
			'org_perm_update_reservation_payment_any',
		)
		expect(getReservationsRolePreset('owner').permissions).toHaveLength(8)
		expect(getReservationsRolePreset('owner').permissionIds).toHaveLength(8)
	})

	it('validates preset keys', () => {
		for (const key of RESERVATIONS_ROLE_PRESET_KEYS) {
			expect(isReservationsRolePresetKey(key)).toBe(true)
		}
		expect(isReservationsRolePresetKey('admin')).toBe(false)
		expect(isReservationsRolePresetKey(null)).toBe(false)
	})
})
