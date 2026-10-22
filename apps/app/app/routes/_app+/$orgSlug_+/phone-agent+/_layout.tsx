import { Trans } from '@lingui/macro'
import { Icon } from '@repo/ui/icon'
import {
	Item,
	ItemContent,
	ItemDescription,
	ItemMedia,
	ItemTitle,
} from '@repo/ui/item'
import { WorkspacePage } from '@repo/ui/workspace'
import { Outlet, useLoaderData, useLocation } from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import {
	PhoneAgentSettingsHeader,
	phoneAgentSettingsTab,
} from '#app/components/phone-agent/settings-nav.tsx'
import { TestCallSheet } from '#app/components/phone-agent/test-call-sheet.tsx'
import { requirePhoneAgentSectionAccess } from '#app/utils/phone-agent/access.server.ts'
import { getLiveKitConfig } from '#app/utils/phone-agent/livekit.server.ts'
import { getPhoneAgentIsOn } from '#app/utils/phone-agent/phone-agent.server.ts'
import { type Route } from './+types/_layout.ts'

// Each page checks its own permission: setup pages need phone agent read,
// the Calls page needs call read.
export async function loader({ request, params }: Route.LoaderArgs) {
	const { dataRegion, canReadAgent, orgId } =
		await requirePhoneAgentSectionAccess(request, params.orgSlug)
	const agentOn = canReadAgent ? await getPhoneAgentIsOn(orgId) : null
	return {
		regionSupported: dataRegion === 'us',
		liveKitConfigured: Boolean(getLiveKitConfig()),
		canReadAgent,
		/** Null for people who can only see calls. */
		agentOn,
	}
}

export default function PhoneAgentLayout() {
	const { regionSupported, canReadAgent } = useLoaderData<typeof loader>()
	const location = useLocation()
	// The settings pages share one header here, so its tabs stay mounted and
	// the underline glides between Agent, What it knows and Call handling.
	const settingsTab = canReadAgent
		? phoneAgentSettingsTab(location.pathname)
		: null
	const testSheet = canReadAgent ? (
		<TestCallSheet regionSupported={regionSupported} />
	) : null

	// The flow editor renders full-viewport, like the automation builder.
	if (/\/phone-agent\/flow\/?$/.test(location.pathname)) {
		return (
			<>
				<Outlet />
				{testSheet}
			</>
		)
	}

	return (
		<WorkspacePage>
			{regionSupported ? null : (
				<Item variant="muted" role="status">
					<ItemMedia variant="icon">
						<Icon name="info" />
					</ItemMedia>
					<ItemContent>
						<ItemTitle>
							<Trans>Not available in your data region yet</Trans>
						</ItemTitle>
						<ItemDescription>
							<Trans>
								The AI phone agent runs on US infrastructure, so it's only
								available to businesses whose customer data is stored in the US.
								You can set it up, but calls won't connect.
							</Trans>
						</ItemDescription>
					</ItemContent>
				</Item>
			)}
			{settingsTab ? (
				<div className="flex flex-col gap-8">
					<PhoneAgentSettingsHeader active={settingsTab} />
					<Outlet />
				</div>
			) : (
				<Outlet />
			)}
			{testSheet}
		</WorkspacePage>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
