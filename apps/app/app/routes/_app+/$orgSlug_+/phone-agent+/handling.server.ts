import { pickSafeTransferTarget } from '@repo/phone-agent'
import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import { canReadPhoneCalls } from '#app/utils/phone-agent/access.server.ts'
import { getPublishedFlow } from '#app/utils/phone-agent/phone-agent.server.ts'
import { listAgentLines } from '#app/utils/phone-agent/runtime-config.server.ts'
import {
	loadSettingsPage,
	saveSettingsPage,
	settingsPageData,
} from '#app/utils/phone-agent/settings-page.server.ts'
import { type SettingsPatchResult } from '#app/utils/phone-agent/settings-patch.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const page = await loadSettingsPage(request, params.orgSlug)
	const [published, canReadCalls, agentLines] = await Promise.all([
		getPublishedFlow(page.orgId),
		canReadPhoneCalls(request, page.orgId),
		listAgentLines(page.orgId),
	])
	// Press 0 uses resolveTransfer, which needs auto-escalate on and a number
	// the runtime will actually dial (not one of the agent's own lines).
	const hasStaffPhone = Boolean(
		page.settings.autoEscalate &&
		pickSafeTransferTarget([page.settings.escalationPhone], agentLines),
	)
	return settingsPageData({
		businessName: page.orgName,
		languages: page.settings.languages,
		phrases: page.settings.phrases,
		safety: page.settings.safety,
		escalationPhone: page.settings.escalationPhone ?? null,
		transfers: page.settings.transfers,
		contacts: page.settings.contacts,
		transferCases: page.settings.transferCases,
		hasStaffPhone,
		csatEnabled: page.settings.csatEnabled,
		notifications: page.settings.notifications,
		followUp: page.settings.followUp,
		tags: page.settings.tags,
		publishedFlow: published
			? {
					version: published.version,
					publishedAt: published.publishedAt?.toISOString() ?? null,
				}
			: null,
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
