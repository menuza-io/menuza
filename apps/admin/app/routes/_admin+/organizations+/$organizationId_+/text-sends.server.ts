import { msg } from '@lingui/macro'
import { AuditAction, auditService } from '@repo/audit'
import { requireUserWithRole } from '@repo/auth'
import { redirectWithToast } from '@repo/common/toast'
import { db, eq, Organization } from '@repo/database'
import {
	getSmsAllowance,
	grantExtraSmsSends,
} from '@repo/marketing/server/sms-allowance'
import {
	data,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
} from 'react-router'
import { z } from 'zod'
import { getRequestI18n } from '#app/modules/lingui/lingui.server.ts'

/** The most Admin grants in one go; a month rarely needs more than a few. */
export const MAX_GRANT = 100

const grantSchema = z.object({
	intent: z.literal('grant'),
	extra: z.coerce.number().int().min(1).max(MAX_GRANT),
})

/**
 * Admin, Organization, Text sends (#247): what the plan includes, how many
 * marketing text sends the organization used this month, and a grant of extra
 * sends for this month. Numbers only; a grant is audited with the count.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
	await requireUserWithRole(request, 'admin')
	const organization = params.organizationId
		? await db.query.Organization.findFirst({
				columns: { id: true, name: true, planName: true },
				where: eq(Organization.id, params.organizationId),
			})
		: undefined
	if (!organization) {
		throw new Response('Organization not found', { status: 404 })
	}
	return data(
		{
			organization: {
				id: organization.id,
				name: organization.name,
				planName: organization.planName,
			},
			allowance: await getSmsAllowance(organization.id),
		},
		{ headers: { 'Cache-Control': 'private, no-store' } },
	)
}

export async function action({ request, params }: ActionFunctionArgs) {
	const userId = await requireUserWithRole(request, 'admin')
	const parsed = grantSchema.safeParse(
		Object.fromEntries(await request.formData()),
	)
	if (!parsed.success) {
		return data(
			{ error: `Choose a number from 1 to ${MAX_GRANT}.` },
			{ status: 400 },
		)
	}
	if (!params.organizationId) {
		throw new Response('Organization not found', { status: 404 })
	}
	const organization = await db.query.Organization.findFirst({
		columns: { id: true },
		where: eq(Organization.id, params.organizationId),
	})
	if (!organization) {
		throw new Response('Organization not found', { status: 404 })
	}
	const allowance = await grantExtraSmsSends({
		organizationId: organization.id,
		extra: parsed.data.extra,
	})
	await auditService.log({
		action: AuditAction.MARKETING_TEXT_SENDS_GRANTED,
		userId,
		organizationId: organization.id,
		resourceType: 'organization',
		resourceId: organization.id,
		details: `A platform admin granted ${parsed.data.extra} extra marketing text sends for ${allowance.periodKey}.`,
		request,
	})
	const i18n = await getRequestI18n(request)
	return redirectWithToast(`/organizations/${organization.id}/text-sends`, {
		title: i18n._(msg`Extra text sends granted`),
		description: i18n._(
			msg`They count for this month only and are added to the plan's sends.`,
		),
		type: 'success',
	})
}
