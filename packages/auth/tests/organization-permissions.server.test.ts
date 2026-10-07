/**
 * Unit tests for organization permissions
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { db } from '@repo/database'
import {
	parseOrganizationPermissionString,
	userHasOrganizationPermission,
	requireUserWithOrganizationPermission,
	getUserOrganizationPermissions,
	userHasOrganizationPermissionClient,
	getUserOrganizationPermissionsForClient,
	ORG_PERMISSIONS,
} from '../src/organization-permissions.server'

vi.mock('@repo/database', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@repo/database')>()
	return {
		...actual,
		db: {
			select: vi.fn(),
		},
	}
})

function mockSelectResults(...results: unknown[][]) {
	let index = 0
	vi.mocked(db.select).mockImplementation(() => {
		const rows = results[Math.min(index, results.length - 1)] ?? []
		index += 1
		const chain: Record<string, unknown> = {}
		const self = () => chain
		chain.from = self
		chain.innerJoin = self
		chain.where = self
		chain.limit = self
		chain.then = (
			resolve: (value: unknown) => unknown,
			reject?: (reason: unknown) => unknown,
		) => Promise.resolve(rows).then(resolve, reject)
		return chain as ReturnType<typeof db.select>
	})
}

describe('Organization Permissions', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe('parseOrganizationPermissionString', () => {
		it('should parse standard permission string', () => {
			const result = parseOrganizationPermissionString('create:note:own')

			expect(result).toEqual({
				action: 'create',
				entity: 'note',
				access: ['own'],
			})
		})

		it('should parse permission with multiple access levels', () => {
			const result = parseOrganizationPermissionString('read:note:own,org')

			expect(result).toEqual({
				action: 'read',
				entity: 'note',
				access: ['own', 'org'],
			})
		})

		it('should parse permission without access level', () => {
			const result = parseOrganizationPermissionString('delete:organization:')

			expect(result).toEqual({
				action: 'delete',
				entity: 'organization',
				access: [''],
			})
		})

		it('should handle whitespace in permission string', () => {
			const result = parseOrganizationPermissionString(
				'  create  :  note  :  own  ',
			)

			expect(result).toEqual({
				action: 'create',
				entity: 'note',
				access: ['own'],
			})
		})

		it('should handle empty components', () => {
			const result = parseOrganizationPermissionString('::')

			expect(result).toEqual({
				action: '',
				entity: '',
				access: [''],
			})
		})

		it('should parse permission with org_note entity', () => {
			const result = parseOrganizationPermissionString('create:org_note:own')

			expect(result).toEqual({
				action: 'create',
				entity: 'org_note',
				access: ['own'],
			})
		})
	})

	describe('userHasOrganizationPermission', () => {
		it('should return true when user has permission', async () => {
			mockSelectResults([{ action: 'create', entity: 'note', access: 'own' }])

			const result = await userHasOrganizationPermission(
				'user-123',
				'org-123',
				'create:note:own',
			)

			expect(result).toBe(true)
		})

		it('should return false when user does not have permission', async () => {
			mockSelectResults([])

			const result = await userHasOrganizationPermission(
				'user-123',
				'org-123',
				'create:note:own',
			)

			expect(result).toBe(false)
		})

		it('should throw 401 when userId is undefined', async () => {
			await expect(
				requireUserWithOrganizationPermission(
					undefined,
					'org-123',
					'create:note:own',
				),
			).rejects.toMatchObject({ status: 401 })
		})

		it('should throw 403 when user lacks permission', async () => {
			mockSelectResults([])

			await expect(
				requireUserWithOrganizationPermission(
					'user-123',
					'org-123',
					'create:note:own',
				),
			).rejects.toMatchObject({ status: 403 })
		})
	})

	describe('getUserOrganizationPermissions', () => {
		it('should return user permissions for organization', async () => {
			mockSelectResults([
				{
					action: 'create',
					entity: 'note',
					access: 'own',
					description: 'Create notes',
				},
			])

			const result = await getUserOrganizationPermissions('user-123', 'org-123')

			expect(result).toEqual([
				{
					action: 'create',
					entity: 'note',
					access: 'own',
					description: 'Create notes',
				},
			])
		})

		it('should return empty array when user has no permissions', async () => {
			mockSelectResults([])

			const result = await getUserOrganizationPermissions('user-123', 'org-123')

			expect(result).toEqual([])
		})
	})

	describe('userHasOrganizationPermissionClient', () => {
		it('should return true when user has matching permission', () => {
			const userPermissions = [
				{ action: 'create', entity: 'note', access: 'own' },
				{ action: 'read', entity: 'note', access: 'org' },
			]

			const result = userHasOrganizationPermissionClient(
				userPermissions,
				'create:note:own',
			)

			expect(result).toBe(true)
		})

		it('should return false when user lacks permission', () => {
			const userPermissions = [
				{ action: 'create', entity: 'note', access: 'own' },
			]

			const result = userHasOrganizationPermissionClient(
				userPermissions,
				'delete:note:any',
			)

			expect(result).toBe(false)
		})

		it('should return true when user has any of the access levels', () => {
			const userPermissions = [
				{ action: 'read', entity: 'note', access: 'org' },
			]

			const result = userHasOrganizationPermissionClient(
				userPermissions,
				'read:note:own,org',
			)

			expect(result).toBe(true)
		})

		it('should return true when permission has no access level specified', () => {
			const userPermissions = [
				{ action: 'create', entity: 'note', access: 'own' },
			]

			const result = userHasOrganizationPermissionClient(
				userPermissions,
				'create:note:',
			)

			expect(result).toBe(true)
		})

		it('should return false for empty permissions array', () => {
			const result = userHasOrganizationPermissionClient([], 'create:note:own')

			expect(result).toBe(false)
		})
	})

	describe('getUserOrganizationPermissionsForClient', () => {
		it('should return permissions with role details', async () => {
			const permissions = [
				{
					id: 'perm-1',
					action: 'create',
					entity: 'note',
					access: 'own',
					description: 'Create own notes',
				},
			]
			mockSelectResults(
				[
					{
						active: true,
						roleId: 'role-123',
						roleName: 'Admin',
						roleLevel: 100,
					},
				],
				permissions,
			)

			const result = await getUserOrganizationPermissionsForClient(
				'user-123',
				'org-123',
			)

			expect(result).toEqual({
				userId: 'user-123',
				organizationId: 'org-123',
				organizationRole: {
					id: 'role-123',
					name: 'Admin',
					level: 100,
					permissions,
				},
			})
		})

		it('should return null when user is not organization member', async () => {
			mockSelectResults([])

			const result = await getUserOrganizationPermissionsForClient(
				'user-123',
				'org-123',
			)

			expect(result).toBeNull()
		})

		it('should return null when user organization is inactive', async () => {
			mockSelectResults([
				{
					active: false,
					roleId: 'role-123',
					roleName: 'Member',
					roleLevel: 10,
				},
			])

			const result = await getUserOrganizationPermissionsForClient(
				'user-123',
				'org-123',
			)

			expect(result).toBeNull()
		})
	})

	describe('ORG_PERMISSIONS constants', () => {
		it('should have all note permissions', () => {
			expect(ORG_PERMISSIONS.CREATE_NOTE_OWN).toBe('create:note:own')
			expect(ORG_PERMISSIONS.READ_NOTE_OWN).toBe('read:note:own')
			expect(ORG_PERMISSIONS.READ_NOTE_ANY).toBe('read:note:org')
			expect(ORG_PERMISSIONS.UPDATE_NOTE_OWN).toBe('update:note:own')
			expect(ORG_PERMISSIONS.UPDATE_NOTE_ANY).toBe('update:note:org')
			expect(ORG_PERMISSIONS.DELETE_NOTE_OWN).toBe('delete:note:own')
			expect(ORG_PERMISSIONS.DELETE_NOTE_ANY).toBe('delete:note:org')
		})

		it('should have all member permissions', () => {
			expect(ORG_PERMISSIONS.READ_MEMBER_ANY).toBe('read:member:any')
			expect(ORG_PERMISSIONS.CREATE_MEMBER_ANY).toBe('create:member:any')
			expect(ORG_PERMISSIONS.UPDATE_MEMBER_ANY).toBe('update:member:any')
			expect(ORG_PERMISSIONS.DELETE_MEMBER_ANY).toBe('delete:member:any')
		})

		it('should have all settings permissions', () => {
			expect(ORG_PERMISSIONS.READ_SETTINGS_ANY).toBe('read:settings:any')
			expect(ORG_PERMISSIONS.UPDATE_SETTINGS_ANY).toBe('update:settings:any')
		})

		it('should have website permissions', () => {
			expect(ORG_PERMISSIONS.READ_WEBSITE_ANY).toBe('read:website:any')
			expect(ORG_PERMISSIONS.UPDATE_WEBSITE_ANY).toBe('update:website:any')
		})

		it('should have analytics permissions', () => {
			expect(ORG_PERMISSIONS.READ_ANALYTICS_ANY).toBe('read:analytics:any')
		})

		it('should have menu permissions', () => {
			expect(ORG_PERMISSIONS.READ_MENU_ANY).toBe('read:menu:any')
			expect(ORG_PERMISSIONS.UPDATE_MENU_ANY).toBe('update:menu:any')
		})
	})

	describe('Edge cases', () => {
		it('should handle malformed permission strings gracefully', () => {
			const result = parseOrganizationPermissionString('malformed')

			expect(result.action).toBe('malformed')
			expect(result.entity).toBe('')
			expect(result.access).toBeUndefined()
		})

		it('should handle database errors', async () => {
			vi.mocked(db.select).mockImplementation(() => {
				throw new Error('Database error')
			})

			await expect(
				userHasOrganizationPermission('user-123', 'org-123', 'create:note:own'),
			).rejects.toThrow('Database error')
		})
	})
})
