import { AuditAction, auditService } from '@repo/audit'
import { requireUserId, userHasOrganizationPermission } from '@repo/auth'
import {
	DEFAULT_ORDER_ALERT_MINUTES,
	largeOrderAlertSettingsSchema,
	MAX_ALERT_RECIPIENTS_PER_LOCATION,
	MAX_ORDER_ALERT_MINUTES,
	MIN_ORDER_ALERT_MINUTES,
} from '@repo/common/operator-alerts'
import { and, db, eq, OrganizationLocation } from '@repo/database'
import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'
import { readLargeOrderAlert } from '#app/utils/alerts/large-order.server.ts'
import {
	addLocationRecipient,
	confirmRecipientCode,
	listLocationRecipients,
	removeLocationRecipient,
	sendRecipientCode,
	toRecipientView,
	updateRecipientSwitches,
} from '#app/utils/alerts/recipients.server.ts'
import { isOrderAlertsEnabled } from '#app/utils/alerts/switches.server.ts'
import { alertTextsAvailable } from '#app/utils/alerts/text.server.ts'
import { resolveMemberLocationIds } from '#app/utils/location/member-scope.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { checkRateLimit } from '#app/utils/rate-limit.server.ts'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * Settings, Locations, Order alerts (#131, #241, #300): how long an order may
 * stay New before managers hear of it, "tell me about large orders" with its
 * threshold, and the people this location tells about new online orders (an
 * email address or a mobile number, not necessarily a member, confirmed with a
 * one-time code, at most five). Viewing needs `read:settings:any`, changing
 * needs `update:settings:any`, and a member limited to some locations cannot
 * touch another's. Staff contact details only: no guest, ever.
 *
 * Offered only while the organization has `orders.manager_alerts` on (the
 * answer says `enabled: false` otherwise and nothing is written).
 */
async function authorize(
	request: Request,
	params: LoaderFunctionArgs['params'],
	permission:
		| typeof ORG_PERMISSIONS.READ_SETTINGS_ANY
		| typeof ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		name: true,
		dataRegion: true,
	})
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		permission,
	)
	const locationId = params.locationId
	if (!locationId)
		throw new Response('Location ID is required', { status: 400 })
	const scope = await resolveMemberLocationIds(userId, organization.id)
	if (scope !== null && !scope.includes(locationId)) {
		throw new Response('Forbidden', { status: 403 })
	}
	const [location] = await db
		.select({
			id: OrganizationLocation.id,
			orderAlertMinutes: OrganizationLocation.orderAlertMinutes,
			largeOrderAlert: OrganizationLocation.largeOrderAlert,
			largeOrderThreshold: OrganizationLocation.largeOrderThreshold,
			largeOrderThresholdType: OrganizationLocation.largeOrderThresholdType,
		})
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.id, locationId),
				eq(OrganizationLocation.organizationId, organization.id),
			),
		)
		.limit(1)
	if (!location) throw new Response('Location not found', { status: 404 })
	return { userId, organization, location }
}

async function view(
	organization: { id: string; dataRegion: string | null },
	location: NonNullable<Awaited<ReturnType<typeof authorize>>['location']>,
	canEdit: boolean,
) {
	const recipients = await listLocationRecipients(organization.id, location.id)
	const large = readLargeOrderAlert(location.largeOrderAlert)
	return {
		enabled: true as const,
		canEdit,
		waitingMinutes: location.orderAlertMinutes,
		defaultWaitingMinutes: DEFAULT_ORDER_ALERT_MINUTES,
		largeOrder: {
			enabled: large?.enabled ?? false,
			itemThreshold: large?.itemThreshold ?? null,
			amountThreshold: large?.amountThreshold ?? null,
			remindMinutes: large?.remindMinutes ?? 60,
			// The thresholds it falls back on when none is typed.
			fallback: {
				threshold: location.largeOrderThreshold,
				thresholdType: location.largeOrderThresholdType,
			},
		},
		recipients: recipients.map(toRecipientView),
		maxRecipients: MAX_ALERT_RECIPIENTS_PER_LOCATION,
		textsAvailable: alertTextsAvailable(organization.dataRegion),
	}
}

export async function loader({ request, params }: LoaderFunctionArgs) {
	const { userId, organization, location } = await authorize(
		request,
		params,
		ORG_PERMISSIONS.READ_SETTINGS_ANY,
	)
	if (!(await isOrderAlertsEnabled(organization.id))) {
		return Response.json({ enabled: false }, { headers: NO_STORE })
	}
	const canEdit = await userHasOrganizationPermission(
		userId,
		organization.id,
		ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
	)
	return Response.json(await view(organization, location, canEdit), {
		headers: NO_STORE,
	})
}

const optionalNumber = (schema: z.ZodNumber) =>
	z
		.union([z.literal(''), z.coerce.number()])
		.transform((value) => (value === '' ? null : value))
		.pipe(schema.nullable())

const intentSchema = z.discriminatedUnion('intent', [
	z.object({
		intent: z.literal('save_settings'),
		waitingMinutes: optionalNumber(
			z
				.number()
				.int()
				.min(MIN_ORDER_ALERT_MINUTES)
				.max(MAX_ORDER_ALERT_MINUTES),
		),
		largeEnabled: z.enum(['true', 'false']).transform((v) => v === 'true'),
		largeItems: optionalNumber(z.number().int().positive().max(10_000)),
		largeAmount: optionalNumber(z.number().positive().max(10_000_000)),
		largeRemind: z.coerce
			.number()
			.int()
			.min(5)
			.max(24 * 60),
	}),
	z.object({
		intent: z.literal('add_recipient'),
		address: z.string().trim().min(3).max(254),
	}),
	z.object({
		intent: z.literal('send_code'),
		recipientId: z.string().min(1).max(64),
	}),
	z.object({
		intent: z.literal('confirm'),
		recipientId: z.string().min(1).max(64),
		code: z.string().trim().min(4).max(12),
	}),
	z.object({
		intent: z.literal('remove'),
		recipientId: z.string().min(1).max(64),
	}),
	z.object({
		intent: z.literal('switches'),
		recipientId: z.string().min(1).max(64),
		onlineOrders: z.enum(['true', 'false']).transform((v) => v === 'true'),
		scheduledOrders: z.enum(['true', 'false']).transform((v) => v === 'true'),
	}),
])

function fail(status: number, error: string) {
	return Response.json({ ok: false, error }, { status, headers: NO_STORE })
}

export async function action({ request, params }: ActionFunctionArgs) {
	if (request.method !== 'POST') return fail(405, 'method_not_allowed')
	const { userId, organization, location } = await authorize(
		request,
		params,
		ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
	)
	if (!(await isOrderAlertsEnabled(organization.id)))
		return fail(404, 'not_found')
	const parsed = intentSchema.safeParse(
		Object.fromEntries(await request.formData()),
	)
	if (!parsed.success) return fail(400, 'invalid_request')
	const input = parsed.data
	const base = String(process.env.BASE_URL ?? '').replace(/\/$/, '')
	const settingsUrl = `${base}/${organization.slug}/settings/locations/${location.id}`

	switch (input.intent) {
		case 'save_settings': {
			const large = largeOrderAlertSettingsSchema.safeParse({
				enabled: input.largeEnabled,
				itemThreshold: input.largeItems,
				amountThreshold: input.largeAmount,
				remindMinutes: input.largeRemind,
			})
			if (!large.success) return fail(400, 'invalid_request')
			await db
				.update(OrganizationLocation)
				.set({
					orderAlertMinutes: input.waitingMinutes,
					largeOrderAlert: JSON.stringify(large.data),
				})
				.where(
					and(
						eq(OrganizationLocation.id, location.id),
						eq(OrganizationLocation.organizationId, organization.id),
					),
				)
			await auditService.log({
				action: AuditAction.ORG_SETTINGS_UPDATED,
				userId,
				organizationId: organization.id,
				resourceType: 'organization_location',
				resourceId: location.id,
				details: 'Order alert settings updated',
				metadata: {
					waitingMinutes: input.waitingMinutes,
					largeOrderAlert: large.data.enabled,
				},
				request,
			})
			break
		}
		case 'add_recipient': {
			const limit = await checkRateLimit(
				{ type: 'user', value: userId },
				{
					scope: 'order-alert-recipients',
					maxRequests: 20,
					windowMs: 60 * 60 * 1000,
				},
			)
			if (!limit.allowed) return fail(429, 'rate_limited')
			const added = await addLocationRecipient({
				organizationId: organization.id,
				locationId: location.id,
				rawAddress: input.address,
				dataRegion: organization.dataRegion,
				createdBy: userId,
			})
			if (!added.ok) return fail(400, added.error)
			const sent = await sendRecipientCode({
				organizationId: organization.id,
				recipientId: added.recipient.id,
				organizationName: organization.name,
				dataRegion: organization.dataRegion,
				settingsUrl,
			})
			if (!sent.ok) {
				// Kept (unconfirmed) so "Send the code again" can retry.
				return Response.json(
					{
						...(await view(organization, location, true)),
						ok: false,
						error: `code_${sent.error}`,
					},
					{ status: 502, headers: NO_STORE },
				)
			}
			break
		}
		case 'send_code': {
			const limit = await checkRateLimit(
				{ type: 'user', value: userId },
				{
					scope: 'order-alert-codes',
					maxRequests: 20,
					windowMs: 60 * 60 * 1000,
				},
			)
			if (!limit.allowed) return fail(429, 'rate_limited')
			const recipients = await listLocationRecipients(
				organization.id,
				location.id,
			)
			if (!recipients.some((row) => row.id === input.recipientId)) {
				return fail(404, 'not_found')
			}
			const sent = await sendRecipientCode({
				organizationId: organization.id,
				recipientId: input.recipientId,
				organizationName: organization.name,
				dataRegion: organization.dataRegion,
				settingsUrl,
			})
			if (!sent.ok)
				return fail(
					sent.error === 'rate_limited' ? 429 : 502,
					`code_${sent.error}`,
				)
			break
		}
		case 'confirm': {
			const recipients = await listLocationRecipients(
				organization.id,
				location.id,
			)
			if (!recipients.some((row) => row.id === input.recipientId)) {
				return fail(404, 'not_found')
			}
			const confirmed = await confirmRecipientCode({
				organizationId: organization.id,
				recipientId: input.recipientId,
				code: input.code,
			})
			if (!confirmed.ok) return fail(400, confirmed.error)
			break
		}
		case 'remove': {
			const recipients = await listLocationRecipients(
				organization.id,
				location.id,
			)
			if (!recipients.some((row) => row.id === input.recipientId)) {
				return fail(404, 'not_found')
			}
			await removeLocationRecipient({
				organizationId: organization.id,
				recipientId: input.recipientId,
			})
			break
		}
		case 'switches': {
			const recipients = await listLocationRecipients(
				organization.id,
				location.id,
			)
			if (!recipients.some((row) => row.id === input.recipientId)) {
				return fail(404, 'not_found')
			}
			await updateRecipientSwitches({
				organizationId: organization.id,
				recipientId: input.recipientId,
				onlineOrders: input.onlineOrders,
				scheduledOrders: input.scheduledOrders,
			})
			break
		}
	}
	const [fresh] = await db
		.select({
			id: OrganizationLocation.id,
			orderAlertMinutes: OrganizationLocation.orderAlertMinutes,
			largeOrderAlert: OrganizationLocation.largeOrderAlert,
			largeOrderThreshold: OrganizationLocation.largeOrderThreshold,
			largeOrderThresholdType: OrganizationLocation.largeOrderThresholdType,
		})
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.id, location.id))
		.limit(1)
	return Response.json(
		{ ...(await view(organization, fresh ?? location, true)), ok: true },
		{ headers: NO_STORE },
	)
}
