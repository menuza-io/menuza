import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Badge } from '@repo/ui/badge'
import { PageHeader } from '@repo/ui/page-header'
import { WorkspaceTabBar } from '@repo/ui/workspace'
import { useParams, useRouteLoaderData } from 'react-router'
import { type loader as layoutLoader } from '#app/routes/_app+/$orgSlug_+/phone-agent+/_layout.tsx'
import { TestCallButton } from './test-call-sheet.tsx'

export const PHONE_AGENT_LAYOUT_ROUTE_ID =
	'routes/_app+/$orgSlug_+/phone-agent+/_layout'

export type PhoneAgentSettingsTab = 'agent' | 'knowledge' | 'handling'

export function usePhoneAgentLayoutData() {
	return useRouteLoaderData<typeof layoutLoader>(PHONE_AGENT_LAYOUT_ROUTE_ID)
}

/** The settings tab a phone agent path belongs to, or null for other pages. */
export function phoneAgentSettingsTab(
	pathname: string,
): PhoneAgentSettingsTab | null {
	if (/\/phone-agent\/?$/.test(pathname)) return 'agent'
	if (/\/phone-agent\/knowledge\/?$/.test(pathname)) return 'knowledge'
	if (/\/phone-agent\/handling\/?$/.test(pathname)) return 'handling'
	return null
}

/**
 * Title, on/off badge, test call button, and the tabs shared by the three
 * phone agent settings pages. The phone agent layout renders it, so it stays
 * mounted while you move between those pages and the tab underline glides.
 */
export function PhoneAgentSettingsHeader({
	active,
}: {
	active: PhoneAgentSettingsTab
}) {
	const { _ } = useLingui()
	const { orgSlug = '' } = useParams()
	const layout = usePhoneAgentLayoutData()
	const base = `/${orgSlug}/phone-agent`
	const tabs: Array<{
		id: PhoneAgentSettingsTab
		to: string
		label: React.ReactNode
	}> = [
		{ id: 'agent', to: base, label: <Trans>Agent</Trans> },
		{
			id: 'knowledge',
			to: `${base}/knowledge`,
			label: <Trans>What it knows</Trans>,
		},
		{
			id: 'handling',
			to: `${base}/handling`,
			label: <Trans>Call handling</Trans>,
		},
	]

	return (
		<div className="flex flex-col gap-4">
			<PageHeader
				title={<Trans>Phone agent</Trans>}
				description={
					<Trans>
						An AI agent that answers your business's calls, answers common
						questions, and texts callers helpful links.
					</Trans>
				}
				actions={
					<>
						{layout?.agentOn != null ? (
							<Badge variant={layout.agentOn ? 'default' : 'secondary'}>
								{layout.agentOn ? (
									<Trans>Answering calls</Trans>
								) : (
									<Trans>Off</Trans>
								)}
							</Badge>
						) : null}
						<TestCallButton />
					</>
				}
			/>
			<WorkspaceTabBar
				label={_(msg`Phone agent settings`)}
				tabs={tabs.map((tab) => ({
					label: tab.label,
					href: tab.to,
					isActive: tab.id === active,
				}))}
			/>
		</div>
	)
}
