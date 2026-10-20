import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { PageHeader } from '@repo/ui/page-header'
import { Link, useParams, useRouteLoaderData } from 'react-router'
import { type loader as layoutLoader } from '#app/routes/_app+/$orgSlug_+/phone-agent+/_layout.tsx'
import { TestCallButton } from './test-call-sheet.tsx'

export const PHONE_AGENT_LAYOUT_ROUTE_ID =
	'routes/_app+/$orgSlug_+/phone-agent+/_layout'

export type PhoneAgentSettingsTab = 'agent' | 'knowledge' | 'handling'

export function usePhoneAgentLayoutData() {
	return useRouteLoaderData<typeof layoutLoader>(PHONE_AGENT_LAYOUT_ROUTE_ID)
}

/**
 * Title, on/off badge, test call button, and the tabs shared by the three
 * phone agent settings pages.
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
			<nav
				aria-label={_(msg`Phone agent settings`)}
				className="flex flex-wrap gap-1 border-b pb-2"
			>
				{tabs.map((tab) => (
					<Button
						key={tab.id}
						variant={tab.id === active ? 'secondary' : 'ghost'}
						size="sm"
						render={
							<Link
								to={tab.to}
								aria-current={tab.id === active ? 'page' : undefined}
							/>
						}
					>
						{tab.label}
					</Button>
				))}
			</nav>
		</div>
	)
}
