import { requireUserId } from '@repo/auth'
import type * as DatabaseModule from '@repo/database'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import {
	mockDb,
	mockSelectResults,
	resetMockDb,
} from '#tests/setup/drizzle-mock.ts'
import { action, loader } from './index.tsx'

vi.mock('@repo/auth', () => ({
	requireUserId: vi.fn().mockResolvedValue('user1'),
}))

vi.mock('@repo/security', () => ({
	checkHoneypot: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@repo/database', async (importOriginal) => {
	const actual = await importOriginal<typeof DatabaseModule>()
	const { mockDb, drizzleTable, drizzleOperator } =
		await import('#tests/setup/drizzle-mock.ts')
	return {
		...actual,
		db: mockDb,
		Notification: drizzleTable,
		Organization: drizzleTable,
		and: drizzleOperator,
		count: drizzleOperator,
		desc: drizzleOperator,
		eq: drizzleOperator,
		like: drizzleOperator,
		not: drizzleOperator,
	}
})

describe('Notifications API Routes', () => {
	beforeEach(() => {
		resetMockDb()
	})

	describe('loader', () => {
		it('returns notifications for user', async () => {
			mockSelectResults([], [{ value: 0 }], [])

			const request = new Request('http://localhost/api/notifications')
			const response = await loader({ request, params: {} } as any)
			const data = (await response.json()) as any

			expect(data).toEqual({
				notifications: [],
				unreadCount: 0,
			})
			expect(requireUserId).toHaveBeenCalledWith(request)
			expect(mockDb.select).toHaveBeenCalledTimes(3)
		})

		it('applies orgSlug filter if provided', async () => {
			mockSelectResults([{ id: 'org1' }], [], [{ value: 0 }], [])

			const request = new Request(
				'http://localhost/api/notifications?orgSlug=acme',
			)
			await loader({ request, params: {} } as any)

			expect(mockDb.select).toHaveBeenCalledTimes(4)
		})
	})

	describe('action', () => {
		it('handles markAllAsRead', async () => {
			const formData = new FormData()
			formData.append('intent', 'markAllAsRead')
			const request = new Request('http://localhost/api/notifications', {
				method: 'POST',
				body: formData,
			})

			const response = await action({ request, params: {} } as any)
			const data = (await response.json()) as any

			expect(data.success).toBe(true)
			expect(mockDb.update).toHaveBeenCalledTimes(1)
		})

		it('handles markAllAsRead with orgSlug', async () => {
			mockSelectResults([{ id: 'org1' }])

			const formData = new FormData()
			formData.append('intent', 'markAllAsRead')
			formData.append('orgSlug', 'acme')
			const request = new Request('http://localhost/api/notifications', {
				method: 'POST',
				body: formData,
			})

			const response = await action({ request, params: {} } as any)
			const data = (await response.json()) as any

			expect(data.success).toBe(true)
			expect(mockDb.select).toHaveBeenCalledTimes(1)
			expect(mockDb.update).toHaveBeenCalledTimes(1)
		})

		it('handles markAsRead', async () => {
			const formData = new FormData()
			formData.append('intent', 'markAsRead')
			formData.append('notificationId', 'notif1')
			const request = new Request('http://localhost/api/notifications', {
				method: 'POST',
				body: formData,
			})

			const response = await action({ request, params: {} } as any)
			const data = (await response.json()) as any

			expect(data.success).toBe(true)
			expect(mockDb.update).toHaveBeenCalledTimes(1)
		})
	})
})
