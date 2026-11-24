import { z } from 'zod'
import { jwtAuthApi } from '../api'

/**
 * The phone's Alerts tab feed (#516): the inventory and staffing notifications
 * of the selected organization, the same rows the web bell shows. The App
 * applies the same visibility rules (a member never sees an alert for a module
 * they cannot open). Push (#106) delivers the same rows; this is the in-app list.
 */
export const alertRowSchema = z.object({
	id: z.string(),
	type: z.string(),
	isRead: z.boolean(),
	createdAt: z.number(),
	payload: z.record(z.string(), z.unknown()),
})
export type AlertRow = z.infer<typeof alertRowSchema>

const feedSchema = z.object({
	organizationId: z.string(),
	unreadCount: z.number(),
	alerts: z.array(alertRowSchema),
})
export type AlertsFeed = z.infer<typeof feedSchema>

export type AlertsResult =
	{ ok: true; feed: AlertsFeed } | { ok: false; status: number; code: string }

export async function fetchAlerts(
	organizationId: string,
	take = 50,
): Promise<AlertsResult> {
	const response = await jwtAuthApi.authenticatedGet<unknown>(
		`/api/alerts?organizationId=${encodeURIComponent(organizationId)}&take=${take}`,
	)
	if (!response.success || !response.data) {
		return {
			ok: false,
			status: response.status,
			code: response.error || 'unknown_error',
		}
	}
	const parsed = feedSchema.safeParse(response.data)
	return parsed.success
		? { ok: true, feed: parsed.data }
		: { ok: false, status: 502, code: 'malformed_response' }
}

export async function markAlertsRead(
	organizationId: string,
	notificationId?: string,
): Promise<boolean> {
	const response = await jwtAuthApi.authenticatedSend<unknown>(
		'POST',
		'/api/alerts',
		notificationId
			? { intent: 'markAsRead', organizationId, notificationId }
			: { intent: 'markAllAsRead', organizationId },
	)
	return response.success
}
