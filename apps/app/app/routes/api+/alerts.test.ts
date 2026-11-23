/**
 * #516: the phone's Alerts tab. Real route, bearer login and database; the
 * per-module visibility filter (which reads flags and permissions) is replaced
 * by a pass-through, since it has its own tests.
 */
import { and, db, eq, Notification } from '@repo/database'
import { describe, expect, it, vi } from 'vitest'
import { createTokenPair } from '#app/utils/jwt.server.ts'
import { setupTestOrgWithUser } from '#tests/test-utils.ts'

vi.mock('#app/utils/staffing/notification-visibility.server.ts', () => ({
	filterVisibleNotifications: async (_userId: string, rows: unknown[]) => rows,
}))

import { action, loader } from './alerts.ts'

async function bearer(user: { id: string; email: string; username: string }) {
	const tokens = await createTokenPair(
		{ id: user.id, email: user.email, username: user.username },
		{ userAgent: 'test', ip: '127.0.0.1' },
	)
	return `Bearer ${tokens.accessToken}`
}

async function call(
	fn: typeof loader | typeof action,
	request: Request,
): Promise<{ status: number; body: Record<string, any> }> {
	const result = (await fn({ request, params: {}, context: {} } as never)) as {
		data?: Record<string, any>
		init?: { status?: number }
	}
	return { status: result?.init?.status ?? 200, body: result.data ?? {} }
}

const list = (organizationId: string, auth?: string) =>
	call(
		loader,
		new Request(
			`http://localhost:3000/api/alerts?organizationId=${organizationId}`,
			{ headers: auth ? { Authorization: auth } : {} },
		),
	)

async function note(
	userId: string,
	organizationId: string,
	type: string,
	payload: Record<string, unknown>,
	createdAt: number,
) {
	const [row] = await db
		.insert(Notification)
		.values({
			userId,
			organizationId,
			type,
			entityId: `${type}-${createdAt}`,
			payload: JSON.stringify(payload),
			createdAt: new Date(createdAt),
		})
		.returning()
	return row!
}

describe('GET and POST /api/alerts (the phone app)', () => {
	it('needs a bearer login and an organization the member is in', async () => {
		const mine = await setupTestOrgWithUser('admin')
		const theirs = await setupTestOrgWithUser('admin')
		expect((await list(mine.organization.id)).status).toBe(401)
		expect(
			(await list(theirs.organization.id, await bearer(mine.user))).status,
		).toBe(404)
	})

	it('lists inventory and staffing alerts, newest first, and nothing else', async () => {
		const { user, organization } = await setupTestOrgWithUser('admin')
		await note(
			user.id,
			organization.id,
			'inventory-count-overdue',
			{ kind: 'inventory_count_overdue', count: 1 },
			3000,
		)
		await note(
			user.id,
			organization.id,
			'staffing-timeclock-missed',
			{ count: 2 },
			2000,
		)
		await note(user.id, organization.id, 'orders-new', { count: 1 }, 5000)
		await note(user.id, organization.id, 'inventory-email-sent', {}, 4000)
		const { status, body } = await list(organization.id, await bearer(user))
		expect(status).toBe(200)
		expect(body.data.alerts.map((a: { type: string }) => a.type)).toEqual([
			'inventory-count-overdue',
			'staffing-timeclock-missed',
		])
		expect(body.data.unreadCount).toBe(2)
		expect(body.data.alerts[0].payload).toEqual({
			kind: 'inventory_count_overdue',
			count: 1,
		})
	})

	it("never lists another person's alerts", async () => {
		const mine = await setupTestOrgWithUser('admin')
		const other = await setupTestOrgWithUser('admin')
		await note(
			other.user.id,
			mine.organization.id,
			'inventory-low-stock',
			{ count: 4 },
			1000,
		)
		const { body } = await list(mine.organization.id, await bearer(mine.user))
		expect(body.data.alerts).toEqual([])
	})

	it('marks one alert, or all, as read', async () => {
		const { user, organization } = await setupTestOrgWithUser('admin')
		const first = await note(
			user.id,
			organization.id,
			'inventory-low-stock',
			{ count: 1 },
			1000,
		)
		await note(
			user.id,
			organization.id,
			'inventory-price-rise',
			{ count: 1 },
			2000,
		)
		const auth = await bearer(user)
		const post = (body: unknown) =>
			call(
				action,
				new Request('http://localhost:3000/api/alerts', {
					method: 'POST',
					headers: { Authorization: auth, 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
				}),
			)
		await post({
			intent: 'markAsRead',
			organizationId: organization.id,
			notificationId: first.id,
		})
		let rows = await db
			.select()
			.from(Notification)
			.where(
				and(eq(Notification.userId, user.id), eq(Notification.isRead, true)),
			)
		expect(rows.map((row) => row.id)).toEqual([first.id])
		await post({ intent: 'markAllAsRead', organizationId: organization.id })
		rows = await db
			.select()
			.from(Notification)
			.where(
				and(eq(Notification.userId, user.id), eq(Notification.isRead, false)),
			)
		expect(rows).toEqual([])
		expect((await post({ intent: 'nope' })).status).toBe(400)
	})
})
