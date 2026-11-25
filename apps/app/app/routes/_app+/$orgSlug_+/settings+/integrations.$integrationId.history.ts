import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import {
	listIntegrationSyncHistory,
	retryIntegrationSyncLog,
} from '#app/utils/integrations/sync-history.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

async function authorize(
	request: Request,
	params: LoaderFunctionArgs['params'],
) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
	})
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
	)
	const integrationId = params.integrationId?.trim()
	if (!integrationId) {
		throw new Response('Integration not found', { status: 404 })
	}
	return { organization, integrationId }
}

/**
 * Returns paged, redacted sync history for a connected POS/delivery
 * integration (#94). Requires `update:settings:any` and org ownership.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
	const { organization, integrationId } = await authorize(request, params)
	const url = new URL(request.url)
	const rawPage = Number(url.searchParams.get('page') ?? '1')
	const page =
		Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1
	const failuresOnly = url.searchParams.get('status') === 'error'

	const history = await listIntegrationSyncHistory(
		organization.id,
		integrationId,
		{ page, failuresOnly },
	)
	if (!history) {
		throw new Response('Integration not found', { status: 404 })
	}

	return Response.json(history, { headers: NO_STORE })
}

/**
 * Retries a failed sync log entry (`intent=retry`).
 */
export async function action({ request, params }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return Response.json(
			{ ok: false, error: 'Method not allowed' },
			{ status: 405, headers: NO_STORE },
		)
	}

	const { organization, integrationId } = await authorize(request, params)
	const formData = await request.formData()
	const intent = formData.get('intent')
	if (intent !== 'retry') {
		return Response.json(
			{ ok: false, error: 'Invalid intent' },
			{ status: 400, headers: NO_STORE },
		)
	}

	const logId = String(formData.get('logId') ?? '').trim()
	if (!logId) {
		return Response.json(
			{ ok: false, error: 'logId is required' },
			{ status: 400, headers: NO_STORE },
		)
	}

	const result = await retryIntegrationSyncLog(
		organization.id,
		integrationId,
		logId,
	)
	if (!result.ok) {
		return Response.json(
			{ ok: false, error: result.error },
			{ status: result.status, headers: NO_STORE },
		)
	}

	return Response.json(result, { headers: NO_STORE })
}
