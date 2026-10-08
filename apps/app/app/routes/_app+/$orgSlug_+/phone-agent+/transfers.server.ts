import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import {
	loadSettingsPage,
	saveSettingsPage,
	settingsPageData,
} from '#app/utils/phone-agent/settings-page.server.ts'
import { type SettingsPatchResult } from '#app/utils/phone-agent/settings-patch.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const page = await loadSettingsPage(request, params.orgSlug)
	return settingsPageData({
		transfers: page.settings.transfers,
		contacts: page.settings.contacts,
		transferCases: page.settings.transferCases,
		autoEscalate: page.settings.autoEscalate,
		escalationPhone: page.settings.escalationPhone ?? null,
		transfersDisabled: page.settings.safety.transfersDisabled,
		versions: page.versions,
		canUpdate: page.canUpdate,
	})
}

export async function action({
	request,
	params,
}: ActionFunctionArgs): Promise<SettingsPatchResult> {
	const body: unknown = await request.json().catch(() => null)
	return saveSettingsPage(request, params.orgSlug, body)
}
