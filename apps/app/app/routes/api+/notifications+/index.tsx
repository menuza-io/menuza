import { requireUserId } from '@repo/auth'
import {
	and,
	count,
	db,
	desc,
	eq,
	Organization,
	Notification,
	like,
	not,
	or,
} from '@repo/database'
import { checkHoneypot } from '@repo/security'

import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'
import { countVisibleReservationAlerts } from '#app/utils/reservations/notification-visibility.server.ts'
import {
	filterVisibleNotifications,
	countVisibleStaffingAlerts,
} from '#app/utils/staffing/notification-visibility.server.ts'

export async function loader({ request }: LoaderFunctionArgs) {
	const userId = await requireUserId(request)
	const url = new URL(request.url)
	const takeParam = Number(url.searchParams.get('take') || '50')
	const take = Number.isNaN(takeParam)
		? 50
		: Math.min(100, Math.max(1, takeParam))

	const orgSlug = url.searchParams.get('orgSlug')

	let organizationId: string | undefined
	if (orgSlug) {
		const [org] = await db
			.select({ id: Organization.id })
			.from(Organization)
			.where(eq(Organization.slug, orgSlug))
			.limit(1)
		if (org) organizationId = org.id
	}

	const whereClause = and(
		eq(Notification.userId, userId),
		organizationId
			? eq(Notification.organizationId, organizationId)
			: undefined,
	)
	const staffingType = like(Notification.type, 'staffing-%')
	const reservationsType = like(Notification.type, 'reservations-%')
	const [rows, unread, unreadAlerts] = await Promise.all([
		db
			.select()
			.from(Notification)
			.where(whereClause)
			.orderBy(desc(Notification.createdAt))
			.limit(take),
		// Time clock alerts are counted below, once it is known which the member
		// can still open.
		db
			.select({ value: count() })
			.from(Notification)
			.where(
				and(
					whereClause,
					eq(Notification.isRead, false),
					not(staffingType),
					not(reservationsType),
				),
			),
		db
			.select({
				organizationId: Notification.organizationId,
				type: Notification.type,
			})
			.from(Notification)
			.where(
				and(
					whereClause,
					eq(Notification.isRead, false),
					or(staffingType, reservationsType),
				),
			),
	])
	const unreadStaffing = unreadAlerts.filter((alert) =>
		alert.type.startsWith('staffing-'),
	)
	const unreadReservations = unreadAlerts.filter((alert) =>
		alert.type.startsWith('reservations-'),
	)
	const notifications = await filterVisibleNotifications(userId, rows)
	let unreadCount = unread[0]?.value ?? 0
	if (unreadStaffing.length > 0) {
		unreadCount += await countVisibleStaffingAlerts(userId, unreadStaffing)
	}
	unreadCount += await countVisibleReservationAlerts(userId, unreadReservations)

	return Response.json({ notifications, unreadCount })
}

const actionSchema = z.discriminatedUnion('intent', [
	z.object({
		intent: z.literal('markAsRead'),
		notificationId: z.string(),
		orgSlug: z.string().optional(),
	}),
	z.object({
		intent: z.literal('markAllAsRead'),
		orgSlug: z.string().optional(),
	}),
])

export async function action({ request }: ActionFunctionArgs) {
	const userId = await requireUserId(request)
	const formData = await request.formData()
	await checkHoneypot(formData)

	const result = actionSchema.safeParse(Object.fromEntries(formData))

	if (!result.success) {
		return Response.json({ error: result.error.message }, { status: 400 })
	}

	const data = result.data

	switch (data.intent) {
		case 'markAsRead': {
			let organizationId: string | undefined
			if (data.orgSlug) {
				const [org] = await db
					.select({ id: Organization.id })
					.from(Organization)
					.where(eq(Organization.slug, data.orgSlug))
					.limit(1)
				if (org) organizationId = org.id
			}
			await db
				.update(Notification)
				.set({ isRead: true, isSeen: true })
				.where(
					and(
						eq(Notification.id, data.notificationId),
						eq(Notification.userId, userId),
						organizationId
							? eq(Notification.organizationId, organizationId)
							: undefined,
					),
				)
			return Response.json({ success: true })
		}
		case 'markAllAsRead': {
			let organizationId: string | undefined
			if (data.orgSlug) {
				const [org] = await db
					.select({ id: Organization.id })
					.from(Organization)
					.where(eq(Organization.slug, data.orgSlug))
					.limit(1)
				if (org) organizationId = org.id
			}

			await db
				.update(Notification)
				.set({ isRead: true, isSeen: true })
				.where(
					and(
						eq(Notification.userId, userId),
						eq(Notification.isRead, false),
						organizationId
							? eq(Notification.organizationId, organizationId)
							: undefined,
					),
				)
			return Response.json({ success: true })
		}
	}
}
