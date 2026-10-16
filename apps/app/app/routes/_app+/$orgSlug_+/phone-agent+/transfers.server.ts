import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import { pickSafeTransferTarget } from '@repo/phone-agent'
import { listAgentLines } from '#app/utils/phone-agent/runtime-config.server.ts'
import {
	loadSettingsPage,
	saveSettingsPage,
	settingsPageData,
} from '#app/utils/phone-agent/settings-page.server.ts'
import { type SettingsPatchResult } from '#app/utils/phone-agent/settings-patch.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const page = await loadSettingsPage(request, params.orgSlug)
	const agentLines = await listAgentLines(page.orgId)
	// Press 0 uses resolveTransfer, which needs the Setup toggle on and a
	// number the runtime will actually dial (not one of the agent's own lines).
	// A flow transfer step dials the number without the toggle; the flow
	// loader checks that case on its own.
	const hasStaffPhone = Boolean(
		page.settings.autoEscalate &&
			pickSafeTransferTarget([page.settings.escalationPhone], agentLines),
	)
	return settingsPageData({
		transfers: page.settings.transfers,
		contacts: page.settings.contacts,
		transferCases: page.settings.transferCases,
		autoEscalate: page.settings.autoEscalate,
		escalationPhone: page.settings.escalationPhone ?? null,
		hasStaffPhone,
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
