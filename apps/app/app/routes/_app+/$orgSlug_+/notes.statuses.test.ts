import type * as DatabaseModule from '@repo/database'
import { describe, it, expect, beforeEach, vi } from 'vitest'

import { validateOrgAccess } from '#app/utils/organization/loader.server.ts'
import type * as PermissionsModule from '#app/utils/organization/permissions.server.ts'
import { requireUserWithOrganizationPermission } from '#app/utils/organization/permissions.server.ts'
import {
	mockDb,
	mockSelectResults,
	mockUpdateReturning,
	resetMockDb,
} from '#tests/setup/drizzle-mock.ts'
import { action as reorderNotesAction } from './notes.reorder.tsx'
import { action as statusIdAction } from './notes.status.$statusId.tsx'
import { action as reorderStatusesAction } from './notes.statuses.reorder.tsx'
import { action as createStatusAction } from './notes.statuses.tsx'

vi.hoisted(() => {
	process.env.SESSION_SECRET = 'test-session-secret'
	process.env.JWT_SECRET = 'test-jwt-secret-key'
	process.env.DATABASE_URL = 'file:./data.db'
	process.env.AWS_ENDPOINT_URL_S3 = 'http://localhost:9000'
	process.env.AWS_REGION = 'us-east-1'
	process.env.AWS_ACCESS_KEY_ID = 'test'
	process.env.AWS_SECRET_ACCESS_KEY = 'test'
	process.env.BUCKET_NAME = 'test'
})

vi.mock(
	'#app/utils/organization/permissions.server.ts',
	async (importOriginal) => {
		const actual = await importOriginal<typeof PermissionsModule>()
		return {
			...actual,
			ORG_PERMISSIONS: actual.ORG_PERMISSIONS ?? {
				CREATE_NOTE_OWN: 'create:note:own',
				UPDATE_NOTE_OWN: 'update:note:own',
				UPDATE_NOTE_ANY: 'update:note:org',
				UPDATE_SETTINGS_ANY: 'update:settings:any',
			},
			requireUserWithOrganizationPermission: vi.fn(),
		}
	},
)

vi.mock('#app/utils/organization/loader.server.ts', () => ({
	validateOrgAccess: vi.fn(),
}))

vi.mock('@repo/auth', () => ({
	requireUserId: vi.fn().mockResolvedValue('user-read-only'),
}))

vi.mock('@repo/database', async (importOriginal) => {
	const actual = await importOriginal<typeof DatabaseModule>()
	const { mockDb, drizzleTable, drizzleOperator } =
		await import('#tests/setup/drizzle-mock.ts')
	return {
		...actual,
		db: mockDb,
		Organization: drizzleTable,
		OrganizationNote: drizzleTable,
		OrganizationNoteStatus: drizzleTable,
		and: drizzleOperator,
		asc: drizzleOperator,
		desc: drizzleOperator,
		eq: drizzleOperator,
		isNull: drizzleOperator,
		ne: drizzleOperator,
	}
})

describe('Kanban Routes Authorization (WO-88)', () => {
	const mockRequirePermission = vi.mocked(requireUserWithOrganizationPermission)

	beforeEach(() => {
		resetMockDb()
	})

	describe('notes.statuses action (Create Status)', () => {
		it('denies read-only roles lacking UPDATE_SETTINGS_ANY (403)', async () => {
			mockSelectResults([{ id: 'org-123' }])
			mockRequirePermission.mockRejectedValue(
				new Response('Insufficient permissions', { status: 403 }),
			)

			const formData = new FormData()
			formData.append('name', 'In Progress')

			const request = new Request(
				'http://localhost:3000/org-slug/notes/statuses',
				{
					method: 'POST',
					body: formData,
				},
			)

			await expect(
				createStatusAction({
					request,
					params: { orgSlug: 'org-slug' },
					context: {},
				} as any),
			).rejects.toThrow(Response)

			expect(mockRequirePermission).toHaveBeenCalledWith(
				request,
				'org-123',
				'update:settings:any',
			)
		})

		it('rejects names over the max length instead of truncating (400)', async () => {
			mockSelectResults([{ id: 'org-123' }])
			mockRequirePermission.mockResolvedValue('user-1')

			const formData = new FormData()
			formData.append('name', 'x'.repeat(101))

			const response = (await createStatusAction({
				request: new Request('http://localhost:3000/org-slug/notes/statuses', {
					method: 'POST',
					body: formData,
				}),
				params: { orgSlug: 'org-slug' },
				context: {},
			} as any)) as Response

			expect(response.status).toBe(400)
		})
	})

	describe('notes.status.$statusId action (Rename / Delete Status)', () => {
		it('denies read-only roles on PATCH (403)', async () => {
			mockSelectResults([{ id: 'org-123' }])
			mockRequirePermission.mockRejectedValue(
				new Response('Insufficient permissions', { status: 403 }),
			)

			const formData = new FormData()
			formData.append('name', 'Renamed')

			const request = new Request(
				'http://localhost:3000/org-slug/notes/status/status-1',
				{
					method: 'PATCH',
					body: formData,
				},
			)

			await expect(
				statusIdAction({
					request,
					params: { orgSlug: 'org-slug', statusId: 'status-1' },
					context: {},
				} as any),
			).rejects.toThrow(Response)

			expect(mockRequirePermission).toHaveBeenCalledWith(
				request,
				'org-123',
				'update:settings:any',
			)
		})

		it('denies read-only roles on DELETE (403)', async () => {
			mockSelectResults([{ id: 'org-123' }])
			mockRequirePermission.mockRejectedValue(
				new Response('Insufficient permissions', { status: 403 }),
			)

			const request = new Request(
				'http://localhost:3000/org-slug/notes/status/status-1',
				{
					method: 'DELETE',
				},
			)

			await expect(
				statusIdAction({
					request,
					params: { orgSlug: 'org-slug', statusId: 'status-1' },
					context: {},
				} as any),
			).rejects.toThrow(Response)

			expect(mockRequirePermission).toHaveBeenCalledWith(
				request,
				'org-123',
				'update:settings:any',
			)
		})

		it('allows permitted role on PATCH rename and returns updated status', async () => {
			mockSelectResults([{ id: 'org-123' }], [])
			mockUpdateReturning([
				{
					id: 'status-1',
					name: 'Renamed',
					color: null,
					position: 1,
				},
			])
			mockRequirePermission.mockResolvedValue('user-123')

			const formData = new FormData()
			formData.append('name', 'Renamed')

			const request = new Request(
				'http://localhost:3000/org-slug/notes/status/status-1',
				{
					method: 'PATCH',
					body: formData,
				},
			)

			const response = (await statusIdAction({
				request,
				params: { orgSlug: 'org-slug', statusId: 'status-1' },
				context: {},
			} as any)) as Response

			const data = (await response.json()) as any
			expect(data.name).toBe('Renamed')
			expect(mockRequirePermission).toHaveBeenCalledWith(
				request,
				'org-123',
				'update:settings:any',
			)
			expect(mockDb.update).toHaveBeenCalled()
		})

		it('allows permitted role on DELETE and updates notes statusId to null', async () => {
			mockSelectResults([{ id: 'org-123' }])
			mockRequirePermission.mockResolvedValue('user-123')

			const request = new Request(
				'http://localhost:3000/org-slug/notes/status/status-1',
				{
					method: 'DELETE',
				},
			)

			const response = (await statusIdAction({
				request,
				params: { orgSlug: 'org-slug', statusId: 'status-1' },
				context: {},
			} as any)) as Response

			expect(response.status).toBe(200)
			expect(mockRequirePermission).toHaveBeenCalledWith(
				request,
				'org-123',
				'update:settings:any',
			)
			expect(mockDb.transaction).toHaveBeenCalled()
		})
	})

	describe('notes.statuses.reorder action (Reorder Statuses)', () => {
		it('denies read-only roles on status reorder (403)', async () => {
			vi.mocked(validateOrgAccess).mockResolvedValue({ id: 'org-123' } as any)
			mockRequirePermission.mockRejectedValue(
				new Response('Insufficient permissions', { status: 403 }),
			)

			const formData = new FormData()
			formData.append('statusId', 'status-1')
			formData.append('position', '1')

			const request = new Request(
				'http://localhost:3000/org-slug/notes/statuses/reorder',
				{
					method: 'POST',
					body: formData,
				},
			)

			await expect(
				reorderStatusesAction({
					request,
					params: { orgSlug: 'org-slug' },
					context: {},
				} as any),
			).rejects.toThrow(Response)

			expect(mockRequirePermission).toHaveBeenCalledWith(
				request,
				'org-123',
				'update:settings:any',
			)
		})

		it('allows permitted role on status reorder (204)', async () => {
			vi.mocked(validateOrgAccess).mockResolvedValue({ id: 'org-123' } as any)
			mockRequirePermission.mockResolvedValue('user-123')
			mockSelectResults(
				[{ id: 'status-1' }],
				[{ id: 'status-2', position: 100 }],
			)

			const formData = new FormData()
			formData.append('statusId', 'status-1')
			formData.append('position', '0')

			const request = new Request(
				'http://localhost:3000/org-slug/notes/statuses/reorder',
				{
					method: 'POST',
					body: formData,
				},
			)

			const response = (await reorderStatusesAction({
				request,
				params: { orgSlug: 'org-slug' },
				context: {},
			} as any)) as Response

			expect(response.status).toBe(204)
			expect(mockRequirePermission).toHaveBeenCalledWith(
				request,
				'org-123',
				'update:settings:any',
			)
			expect(mockDb.transaction).toHaveBeenCalled()
		})
	})

	describe('notes.reorder action (Reorder Notes)', () => {
		it('denies read-only user updating a note created by another user when lacking UPDATE_NOTE_ANY (403)', async () => {
			vi.mocked(validateOrgAccess).mockResolvedValue({ id: 'org-123' } as any)
			mockSelectResults([{ id: 'note-456', createdById: 'user-other' }])

			mockRequirePermission.mockRejectedValue(
				new Response('Insufficient permissions', { status: 403 }),
			)

			const formData = new FormData()
			formData.append('noteId', 'note-456')
			formData.append('position', '2')

			const request = new Request(
				'http://localhost:3000/org-slug/notes/reorder',
				{
					method: 'POST',
					body: formData,
				},
			)

			await expect(
				reorderNotesAction({
					request,
					params: { orgSlug: 'org-slug' },
					context: {},
				} as any),
			).rejects.toThrow(Response)

			expect(mockRequirePermission).toHaveBeenCalledWith(
				request,
				'org-123',
				'update:note:org',
			)
		})
	})
})
