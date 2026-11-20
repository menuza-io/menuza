import {
	dueExpiryAlert,
	expiryAlertKey,
	showsAccountChecks,
} from '@repo/common/customer-app'
import {
	CustomerApp,
	db,
	eq,
	inArray,
	Notification,
	Organization,
} from '@repo/database'
import { createElement } from 'react'
import { sendEmail, StaffingAlertEmail } from '@repo/email'
import { resolveDomainAlertRecipients } from '#app/utils/domains/notify.server.ts'
import { readLiveEnv } from '#app/utils/env.server.ts'
import {
	CUSTOMER_APP_ALERT_TYPES,
	customerAppAlertEmail,
	customerAppAlertPath,
	type CustomerAppAlertKind,
} from './alerts.ts'

const KIND_FOR_THRESHOLD: Record<30 | 7 | 0, CustomerAppAlertKind> = {
	30: 'expiring_30',
	7: 'expiring_7',
	0: 'expired',
}

/**
 * Developer account expiry alerts (#156): 30 days before, 7 days before and on
 * expiry, to the members who can change settings. Each is sent once per expiry
 * date: the notification row is the claim (unique per member, type and
 * `entityId`), so a renewed account (a new date) re-arms the alerts and a
 * retried job never tells anyone twice. Only apps the restaurant publishes
 * itself are alerted; Menuza's own account is Menuza's to watch (Admin shows
 * it). Never throws for one app: the rest still run.
 */
export async function notifyDueExpiryAlerts(now = Date.now()) {
	const apps = await db
		.select({
			id: CustomerApp.id,
			organizationId: CustomerApp.organizationId,
			publisher: CustomerApp.publisher,
			accountSnapshot: CustomerApp.accountSnapshot,
			status: CustomerApp.status,
		})
		.from(CustomerApp)
		.where(inArray(CustomerApp.status, ['draft', 'published']))
	let told = 0
	for (const app of apps) {
		try {
			if (!showsAccountChecks(app.publisher) || !app.accountSnapshot) continue
			const snapshot = JSON.parse(app.accountSnapshot) as {
				developerAccountExpiresAt?: unknown
			}
			const expiresAt = snapshot.developerAccountExpiresAt
			if (typeof expiresAt !== 'number') continue
			const threshold = dueExpiryAlert(expiresAt, now)
			if (threshold === null) continue
			told += await notify(app.organizationId, app.id, threshold, expiresAt)
		} catch {
			console.error('customer app expiry alert failed', { appId: app.id })
		}
	}
	return { apps: apps.length, told }
}

async function notify(
	organizationId: string,
	appId: string,
	threshold: 30 | 7 | 0,
	expiresAt: number,
): Promise<number> {
	const [organization] = await db
		.select({ slug: Organization.slug })
		.from(Organization)
		.where(eq(Organization.id, organizationId))
		.limit(1)
	if (!organization) return 0
	const kind = KIND_FOR_THRESHOLD[threshold]
	const email = customerAppAlertEmail(kind)
	const url = `${readLiveEnv('BASE_URL').replace(/\/$/u, '')}/${organization.slug}${customerAppAlertPath()}`
	const entityId = `${appId}:${expiryAlertKey(threshold, expiresAt)}`
	let told = 0
	for (const recipient of await resolveDomainAlertRecipients(organizationId)) {
		const inserted = await db
			.insert(Notification)
			.values({
				userId: recipient.userId,
				organizationId,
				type: CUSTOMER_APP_ALERT_TYPES[kind],
				entityId,
				payload: JSON.stringify({ orgSlug: organization.slug, kind }),
			})
			.onConflictDoNothing()
			.returning({ id: Notification.id })
		if (inserted.length === 0) continue
		told += 1
		try {
			await sendEmail({
				to: recipient.email,
				subject: email.subject,
				react: createElement(StaffingAlertEmail, {
					eyebrow: 'Customer app',
					headline: email.headline,
					detail: email.detail,
					actionLabel: 'Open the app page',
					actionUrl: url,
					settingsNote: '',
				}),
			})
		} catch {
			console.error('customer app expiry email failed')
		}
	}
	return told
}
