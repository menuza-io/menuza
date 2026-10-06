import { msg } from '@lingui/macro'
import { AuditAction, auditService } from '@repo/audit'
import { requireUserWithRole } from '@repo/auth'
import {
	CHAT_RETENTION_DAY_OPTIONS,
	type ChatRetentionDays,
} from '@repo/common/chat'
import { redirectWithToast } from '@repo/common/toast'
import { db, eq, Organization } from '@repo/database'
import {
	data,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
} from 'react-router'
import { z } from 'zod'
import { getRequestI18n } from '#app/modules/lingui/lingui.server.ts'

const retentionSchema = z.object({
	intent: z.literal('retention'),
	days: z
		.enum(['forever', '30', '90', '365'])
		.transform((value): ChatRetentionDays =>
			value === 'forever' ? null : (Number(value) as ChatRetentionDays),
		),
})

export async function loader({ request, params }: LoaderFunctionArgs) {
	await requireUserWithRole(request, 'admin')

	const organization = params.organizationId
		? await db.query.Organization.findFirst({
				columns: { id: true, name: true, chatRetentionDays: true },
				where: eq(Organization.id, params.organizationId),
			})
		: undefined

	if (!organization) {
		throw new Response('Organization not found', { status: 404 })
	}

	return data(
		{
			organization: { id: organization.id, name: organization.name },
			retentionDays:
				CHAT_RETENTION_DAY_OPTIONS.find(
					(days) => days === organization.chatRetentionDays,
				) ?? null,
		},
		{ headers: { 'Cache-Control': 'private, no-store' } },
	)
}

export async function action({ request, params }: ActionFunctionArgs) {
	const userId = await requireUserWithRole(request, 'admin')
	const parsed = retentionSchema.safeParse(
		Object.fromEntries(await request.formData()),
	)

	if (!parsed.success) {
		return data({ error: 'Choose a valid retention period.' }, { status: 400 })
	}

	if (!params.organizationId) {
		throw new Response('Organization not found', { status: 404 })
	}

	const days = parsed.data.days
	const [updated] = await db
		.update(Organization)
		.set({ chatRetentionDays: days, updatedAt: new Date() })
		.where(eq(Organization.id, params.organizationId))
		.returning({ id: Organization.id })

	if (!updated) {
		throw new Response('Organization not found', { status: 404 })
	}

	await auditService.log({
		action: AuditAction.CHAT_RETENTION_UPDATED,
		userId,
		organizationId: updated.id,
		resourceType: 'organization',
		resourceId: updated.id,
		details: days
			? `Team chat retention set to ${days} days by a platform admin.`
			: 'Team chat retention set to keep messages forever by a platform admin.',
		request,
	})

	const i18n = await getRequestI18n(request)
	return redirectWithToast(`/organizations/${updated.id}/chat-retention`, {
		title: i18n._(msg`Message retention updated`),
		description: i18n._(
			msg`The policy will apply on the next daily chat cleanup.`,
		),
		type: 'success',
	})
}
