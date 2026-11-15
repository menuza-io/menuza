import { getDomainUrl } from '@repo/common'
import {
	type ActionFunctionArgs,
	data,
	type LoaderFunctionArgs,
} from 'react-router'
import {
	createEmailTemplate,
	listEmailTemplates,
	startFromEmailTemplate,
	type EmailTemplateError,
} from '#app/utils/marketing/email-templates.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireAnyUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'

/**
 * The email designers' door to saved templates (#154), for broadcasts and
 * automations alike: list them, save the open design as one, start from one.
 * Reading needs a read permission of either area, saving needs an update
 * permission of either. Control plane only; a template holds blocks, no guests.
 */

const STATUS: Record<EmailTemplateError, number> = {
	template_limit_reached: 409,
	template_name_taken: 409,
	template_not_found: 404,
	invalid_name: 400,
	invalid_blocks: 400,
}

async function organizationId(request: Request, orgSlug: string | undefined) {
	const organization = (await requireUserOrganization(request, orgSlug, {
		id: true,
	})) as { id: string }
	return organization.id
}

export async function loader({ request, params }: LoaderFunctionArgs) {
	const orgId = await organizationId(request, params.orgSlug)
	await requireAnyUserWithOrganizationPermission(request, orgId, [
		ORG_PERMISSIONS.READ_CAMPAIGN_ANY,
		ORG_PERMISSIONS.READ_AUTOMATION_ANY,
	])
	return { templates: await listEmailTemplates(orgId) }
}

export async function action({ request, params }: ActionFunctionArgs) {
	const orgId = await organizationId(request, params.orgSlug)
	const userId = await requireAnyUserWithOrganizationPermission(
		request,
		orgId,
		[
			ORG_PERMISSIONS.UPDATE_CAMPAIGN_ANY,
			ORG_PERMISSIONS.UPDATE_AUTOMATION_ANY,
		],
	)
	const formData = await request.formData()
	const intent = formData.get('intent')

	if (intent === 'save') {
		const saved = await createEmailTemplate({
			organizationId: orgId,
			userId,
			name: formData.get('name'),
			blocks: formData.get('blocks'),
		})
		return saved.ok
			? { template: saved.value }
			: data({ error: saved.error }, { status: STATUS[saved.error] })
	}

	if (intent === 'start') {
		const started = await startFromEmailTemplate({
			organizationId: orgId,
			id: String(formData.get('id') ?? ''),
			baseUrl: getDomainUrl(request),
		})
		return started.ok
			? { blocks: started.value }
			: data({ error: started.error }, { status: STATUS[started.error] })
	}

	return data({ error: 'invalid_intent' }, { status: 400 })
}
