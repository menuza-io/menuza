import { AuditAction, auditService } from '@repo/audit'
import { db, eq, ImpersonationSession } from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { ENV } from 'varlock/env'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestUser } from '#tests/test-utils.ts'
import { action } from './jobs.impersonation-cleanup.ts'

function args(init: { method?: string; authorized?: boolean } = {}) {
	const url = new URL(
		'http://localhost:3001/resources/jobs/impersonation-cleanup',
	)
	return {
		request: new Request(url, {
			method: init.method ?? 'POST',
			headers:
				init.authorized === false
					? {}
					: { Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}` },
		}),
		params: {},
		context: new RouterContextProvider(),
		url,
		pattern: '/resources/jobs/impersonation-cleanup',
	}
}

async function status(run: () => Promise<unknown>) {
	try {
		const result = await run()
		return result instanceof Response ? result.status : 200
	} catch (error) {
		if (error instanceof Response) return error.status
		throw error
	}
}

async function createSession(expiresAt: Date) {
	const admin = await createTestUser()
	const target = await createTestUser()
	const [row] = await db
		.insert(ImpersonationSession)
		.values({
			adminUserId: admin.id,
			targetUserId: target.id,
			ipHash: 'test',
			createdAt: new Date(expiresAt.getTime() - 15 * 60_000),
			expiresAt,
		})
		.returning({ id: ImpersonationSession.id })
	return { id: row!.id, adminId: admin.id }
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe('impersonation cleanup job', () => {
	it('requires POST and the internal command token', async () => {
		expect(await status(() => action(args({ method: 'GET' }) as never))).toBe(
			405,
		)
		expect(
			await status(() => action(args({ authorized: false }) as never)),
		).toBe(401)
	})

	it('ends expired sessions with an END audit entry and keeps live ones', async () => {
		const log = vi
			.spyOn(auditService, 'logAdminOperation')
			.mockResolvedValue(undefined)
		const expired = await createSession(new Date(Date.now() - 60_000))
		const live = await createSession(new Date(Date.now() + 10 * 60_000))

		const response = (await action(args() as never)) as Response
		expect(response.status).toBe(200)
		const body = (await response.json()) as { success: boolean; ended: number }
		expect(body.success).toBe(true)
		expect(body.ended).toBeGreaterThanOrEqual(1)

		const remaining = async (id: string) =>
			db
				.select({ id: ImpersonationSession.id })
				.from(ImpersonationSession)
				.where(eq(ImpersonationSession.id, id))
		expect(await remaining(expired.id)).toEqual([])
		expect(await remaining(live.id)).toEqual([{ id: live.id }])
		expect(log).toHaveBeenCalledWith(
			AuditAction.ADMIN_IMPERSONATION_END,
			expired.adminId,
			expect.stringContaining('ended (expired)'),
			expect.objectContaining({
				impersonationSessionId: expired.id,
				reason: 'expired',
			}),
			undefined,
		)
		expect(log).not.toHaveBeenCalledWith(
			expect.anything(),
			live.adminId,
			expect.anything(),
			expect.anything(),
			expect.anything(),
		)
	})
})
