import { data } from 'react-router'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import {
	canUpdatePhoneAgent,
	requirePhoneAgentAccess,
} from './access.server.ts'
import { getPhoneAgent } from './phone-agent.server.ts'
import { settingsError } from './settings-errors.ts'
import {
	patchPhoneAgentSettings,
	type SettingsPatchResult,
	settingsVersions,
} from './settings-patch.server.ts'

export async function loadSettingsPage(
	request: Request,
	orgSlug: string | undefined,
) {
	const access = await requirePhoneAgentAccess(request, orgSlug)
	const [agent, canUpdate] = await Promise.all([
		getPhoneAgent(access.orgId),
		canUpdatePhoneAgent(request, access.orgId),
	])
	return {
		...access,
		settings: agent.settings,
		versions: settingsVersions(agent.settings),
		canUpdate,
	}
}

export const NO_STORE = { 'Cache-Control': 'private, no-store' }

export function settingsPageData<T>(value: T) {
	return data(value, { headers: NO_STORE })
}

/**
 * Handles `{ intent: 'save', patch, versions }` JSON posts from settings
 * pages. `versions` are the loader's fingerprints for the keys in `patch`.
 */
export async function saveSettingsPage(
	request: Request,
	orgSlug: string | undefined,
	body: unknown,
): Promise<SettingsPatchResult> {
	const { orgId, userId } = await requirePhoneAgentAccess(
		request,
		orgSlug,
		ORG_PERMISSIONS.UPDATE_PHONE_AGENT_ANY,
	)
	const { patch, versions } =
		body && typeof body === 'object'
			? (body as { patch?: unknown; versions?: unknown })
			: {}
	if (!patch) return { ok: false, error: settingsError('invalid_request') }
	return patchPhoneAgentSettings({
		organizationId: orgId,
		userId,
		request,
		patch,
		versions,
	})
}
