import {
	and,
	db,
	Discount,
	eq,
	Notification,
	Organization,
} from '@repo/database'
import { discountNotifyEventSchema } from '@repo/discounts'
import { StaffingAlertEmail, sendEmail } from '@repo/email'
import { type ActionFunctionArgs } from 'react-router'
import { ENV } from 'varlock/env'
import { resolveDiscountAlertRecipients } from '#app/utils/discounts/alerts.server.ts'
import {
	DISCOUNT_ALERT_TYPES,
	DISCOUNT_EMAIL_ACTION,
	DISCOUNT_EMAIL_EYEBROW,
	discountAlertPath,
	discountBudgetEmail,
} from '#app/utils/discounts/discount-alerts.ts'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * `POST /resources/discounts/notify`: where the region tells the people who
 * change discounts that one reached its weekly budget (#392). The event is an
 * organization id, a kind, a discount id and the week (strict schema: nothing
 * about a guest, an order or an amount). Recipients are the members holding
 * `update:discount:any`, who get an in-app notification and an email, once per
 * discount and week: the notification row is the claim (`entityId` is the
 * discount and week), so a retried or repeated delivery tells nobody twice.
 * Authenticated with `INTERNAL_COMMAND_TOKEN` only.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	try {
		await requireInternalCommandAuth(request)
	} catch (error) {
		if (error instanceof Response && error.status === 401) return error
		throw error
	}
	const parsed = discountNotifyEventSchema.safeParse(
		await request.json().catch(() => null),
	)
	if (!parsed.success) {
		return Response.json(
			{
				error: 'invalid_request',
				issues: parsed.error.issues.slice(0, 10).map((issue) => ({
					path: issue.path.join('.'),
					code: issue.code,
				})),
			},
			{ status: 400, headers: NO_STORE },
		)
	}
	const event = parsed.data
	const organization = await db.query.Organization.findFirst({
		where: and(
			eq(Organization.id, event.orgId),
			eq(Organization.active, true),
			eq(Organization.hasProvisionedDb, true),
		),
		columns: { id: true, slug: true },
	})
	if (!organization) {
		return Response.json(
			{ error: 'org_not_found' },
			{ status: 404, headers: NO_STORE },
		)
	}
	// Only a discount of this organization: an id from elsewhere is not a notice.
	const discount = await db.query.Discount.findFirst({
		where: and(
			eq(Discount.id, event.discountId),
			eq(Discount.organizationId, organization.id),
		),
		columns: { id: true, name: true, weeklyBudgetMinor: true },
	})
	if (!discount) {
		return Response.json(
			{ inApp: 0, skipped: 'unknown_discount' },
			{ headers: NO_STORE },
		)
	}
	// A budget that was removed since is no longer news.
	if (discount.weeklyBudgetMinor === null) {
		return Response.json(
			{ inApp: 0, skipped: 'no_budget' },
			{ headers: NO_STORE },
		)
	}
	const recipients = await resolveDiscountAlertRecipients({
		organizationId: organization.id,
	})
	if (recipients.length === 0) {
		return Response.json(
			{ inApp: 0, skipped: 'no_recipients' },
			{ headers: NO_STORE },
		)
	}
	const baseUrl = String(ENV.BASE_URL ?? '').replace(/\/$/, '')
	const actionUrl = `${baseUrl}/${organization.slug}${discountAlertPath(discount.id)}`
	const copy = discountBudgetEmail(discount.name)
	// One notice per discount and week: the entity id is the claim.
	const entityId = `${discount.id}:${event.week}`

	let inApp = 0
	for (const recipient of recipients) {
		const claimed = await db
			.insert(Notification)
			.values({
				userId: recipient.userId,
				organizationId: organization.id,
				type: DISCOUNT_ALERT_TYPES.budget_reached,
				entityId,
				payload: JSON.stringify({
					orgSlug: organization.slug,
					discountId: discount.id,
					kind: 'budget_reached',
				}),
			})
			.onConflictDoNothing()
			.returning({ id: Notification.id })
		if (claimed.length === 0) continue
		inApp++
		try {
			const result = await sendEmail({
				to: recipient.email,
				subject: copy.subject,
				react: StaffingAlertEmail({
					eyebrow: DISCOUNT_EMAIL_EYEBROW,
					headline: copy.headline,
					detail: copy.detail,
					actionLabel: DISCOUNT_EMAIL_ACTION,
					actionUrl,
					settingsNote: '',
				}),
			})
			if (result.status === 'error') {
				console.error('Failed to send discount alert email')
			}
		} catch {
			console.error('Failed to send discount alert email')
		}
	}
	return Response.json({ inApp }, { headers: NO_STORE })
}
