import { getUserId } from '@repo/auth'
import { redirectWithToast } from '@repo/common/toast'
import { handleOAuthCallback } from '@repo/integrations'
import { type LoaderFunctionArgs } from 'react-router'
import {
	clearIntegrationOAuthState,
	readIntegrationOAuthState,
	sameState,
} from '#app/utils/integrations/oauth-state.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'

/**
 * The OAuth redirect for the note integrations (Slack, Jira, ...). It
 * finishes only what this browser started, for the same signed-in member, who
 * must still be allowed to manage the organization's settings. The
 * organization comes from that record, never from the callback URL.
 */
export async function loader(args: LoaderFunctionArgs) {
	const { request } = args
	const saved = await readIntegrationOAuthState(request)
	const clear = { 'Set-Cookie': await clearIntegrationOAuthState() }
	const userId = await getUserId(request)
	if (!saved || !userId || saved.userId !== userId) {
		throw new Response('This connection was not started here.', {
			status: 400,
			headers: clear,
		})
	}

	const url = new URL(request.url)
	// OAuth 2.0 providers echo `state`; Trello (OAuth 1.0a) echoes its request
	// token instead.
	const echoed =
		url.searchParams.get('state') || url.searchParams.get('oauth_token') || ''
	if (
		!echoed ||
		!sameState(echoed, saved.state) ||
		url.searchParams.get('provider') !== saved.provider
	) {
		throw new Response('This connection does not match.', {
			status: 400,
			headers: clear,
		})
	}

	const organization = await requireUserOrganization(request, saved.orgSlug, {
		id: true,
		slug: true,
	})
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
	)

	return handleOAuthCallback(args, {
		organization,
		requestTokenSecret: saved.requestTokenSecret,
		redirectWithToast: (to, toast) =>
			redirectWithToast(
				to,
				{ ...toast, type: toast.type as 'message' | 'success' | 'error' },
				{ headers: clear },
			),
	})
}
