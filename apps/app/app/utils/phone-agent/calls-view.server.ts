import { getPhoneCallPermissions } from './access.server.ts'
import { getPhoneAgent } from './phone-agent.server.ts'
import { phoneAgentServerVertical } from './vertical.server.ts'

/**
 * What a call list needs from App. Only scope names, tag names, and the
 * viewer's permissions come from here; call data is fetched by the browser
 * from the regional tenant-api.
 */
export async function loadCallsViewData(request: Request, orgId: string) {
	const [scopes, { canUpdate, canDelete }, agent] = await Promise.all([
		phoneAgentServerVertical.listScopes(orgId),
		getPhoneCallPermissions(request, orgId),
		getPhoneAgent(orgId),
	])
	return {
		scopeNames: Object.fromEntries(
			scopes.map((scope) => [scope.id, scope.name]),
		) as Record<string, string>,
		canUpdate,
		canDelete,
		tags: agent.settings.tags.map(({ id, name, important }) => ({
			id,
			name,
			important,
		})),
	}
}

export type CallsViewData = Awaited<ReturnType<typeof loadCallsViewData>>
