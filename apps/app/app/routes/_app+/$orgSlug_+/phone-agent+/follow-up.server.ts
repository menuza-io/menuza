import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import { canReadPhoneCalls } from '#app/utils/phone-agent/access.server.ts'
import {
	loadSettingsPage,
	saveSettingsPage,
	settingsPageData,
} from '#app/utils/phone-agent/settings-page.server.ts'
import { type SettingsPatchResult } from '#app/utils/phone-agent/settings-patch.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const page = await loadSettingsPage(request, params.orgSlug)
	const canReadCalls = await canReadPhoneCalls(request, page.orgId)
	return settingsPageData({
		notifications: page.settings.notifications,
		followUp: page.settings.followUp,
		tags: page.settings.tags,
		versions: page.versions,
		canUpdate: page.canUpdate,
		// Saving still checks this; see patchPhoneAgentSettings.
		canUpdateAlerts: page.canUpdate && canReadCalls,
	})
}

export async function action({
	request,
	params,
}: ActionFunctionArgs): Promise<SettingsPatchResult> {
	const body: unknown = await request.json().catch(() => null)
	return saveSettingsPage(request, params.orgSlug, body)
}
