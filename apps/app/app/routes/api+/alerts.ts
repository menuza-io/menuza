import {
	and,
	db,
	desc,
	eq,
	inArray,
	like,
	Notification,
	or,
} from '@repo/database'
import { data } from 'react-router'
import { z } from 'zod'
import { userHasOrganizationAccess } from '#app/utils/alerts/alerts-feed-access.server.ts'
import { isAuthenticationError, requireAuth } from '#app/utils/jwt.server.ts'
import { filterVisibleNotifications } from '#app/utils/staffing/notification-visibility.server.ts'
import { type Route } from './+types/alerts.ts'

/**
 * The phone app's Alerts tab (#516): the inventory and staffing notifications
 * of one organization that already exist in the bell, newest first. It reads
 * the same `Notification` rows and applies the same visibility rules as the
 * web bell (a member never sees an alert for a module they cannot open). Push
 * (#106) delivers the same rows; this is the in-app list. Rows carry a kind, a
 * count and a location id: never a name, a phone or an amount.
 *
 * GET  `?organizationId=&take=`: the list and the unread count.
 * POST JSON `{ organizationId, intent: markAsRead | markAllAsRead, notificationId }`.
 */

const ID = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/)
const Query = z.object({
	organizationId: ID,
	take: z.coerce.number().int().min(1).max(100).default(50),
})
const Body = z.discriminatedUnion('intent', [
	z.object({
		intent: z.literal('markAsRead'),
		organizationId: ID,
		notificationId: ID,
	}),
	z.object({ intent: z.literal('markAllAsRead'), organizationId: ID }),
])

function failure(status: number, error: string, message: string) {
	return data(
		{ success: false, error, message },
		{ status, headers: { 'Cache-Control': 'private, no-store' } },
	)
}

async function authenticate(request: Request) {
	try {
		return (await requireAuth(request)).sub
	} catch (error) {
		if (isAuthenticationError(error)) return null
		throw error
	}
}

function parsePayload(payload: string): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(payload)
		return value && typeof value === 'object'
			? (value as Record<string, unknown>)
			: {}
	} catch {
		return {}
	}
}

export async function loader({ request }: Route.LoaderArgs) {
	const userId = await authenticate(request)
	if (!userId) return failure(401, 'unauthorized', 'Authentication required')
	const parsed = Query.safeParse(
		Object.fromEntries(new URL(request.url).searchParams),
	)
	if (!parsed.success)
		return failure(400, 'validation_error', 'Invalid request')
	const { organizationId, take } = parsed.data
	if (!(await userHasOrganizationAccess(userId, organizationId))) {
		return failure(404, 'not_found', 'Not found')
	}
	const rows = await db
		.select()
		.from(Notification)
		.where(
			and(
				eq(Notification.userId, userId),
				eq(Notification.organizationId, organizationId),
				or(
					like(Notification.type, 'inventory-%'),
					like(Notification.type, 'staffing-%'),
				),
			),
		)
		.orderBy(desc(Notification.createdAt))
		.limit(take)
	// The hidden email-only marker is not an alert.
	const visible = (await filterVisibleNotifications(userId, rows)).filter(
		(row) => row.type !== 'inventory-email-sent',
	)
	return data(
		{
			success: true,
			data: {
				organizationId,
				unreadCount: visible.filter((row) => !row.isRead).length,
				alerts: visible.map((row) => ({
					id: row.id,
					type: row.type,
					isRead: row.isRead,
					createdAt: row.createdAt.getTime(),
					payload: parsePayload(row.payload),
				})),
			},
		},
		{ headers: { 'Cache-Control': 'private, no-store' } },
	)
}

export async function action({ request }: Route.ActionArgs) {
	const userId = await authenticate(request)
	if (!userId) return failure(401, 'unauthorized', 'Authentication required')
	if (request.method !== 'POST') {
		return failure(405, 'method_not_allowed', 'Method not allowed')
	}
	// The phone sends JSON; a form post works too.
	const raw: unknown = (request.headers.get('content-type') ?? '').includes(
		'application/json',
	)
		? await request.json().catch(() => null)
		: Object.fromEntries(await request.formData().catch(() => new FormData()))
	const parsed = Body.safeParse(raw)
	if (!parsed.success)
		return failure(400, 'validation_error', 'Invalid request')
	const body = parsed.data
	if (!(await userHasOrganizationAccess(userId, body.organizationId))) {
		return failure(404, 'not_found', 'Not found')
	}
	await db
		.update(Notification)
		.set({ isRead: true, isSeen: true })
		.where(
			and(
				eq(Notification.userId, userId),
				eq(Notification.organizationId, body.organizationId),
				or(
					like(Notification.type, 'inventory-%'),
					like(Notification.type, 'staffing-%'),
				),
				body.intent === 'markAsRead'
					? inArray(Notification.id, [body.notificationId])
					: eq(Notification.isRead, false),
			),
		)
	return data({ success: true })
}
