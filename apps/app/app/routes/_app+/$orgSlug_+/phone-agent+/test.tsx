import { Trans } from '@lingui/macro'
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from '@repo/ui/empty'
import { Icon } from '@repo/ui/icon'
import { PageHeader } from '@repo/ui/page-header'
import { useLoaderData, useParams, useRouteLoaderData } from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { TestCallPanel } from '#app/components/phone-agent/test-call-panel.tsx'
import { type Route } from './+types/test.ts'
import { type loader as layoutLoader } from './_layout.tsx'
import { loadTestCallPage, startTestCall } from './test.server.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	return loadTestCallPage(request, params.orgSlug)
}

export async function action({ request, params }: Route.ActionArgs) {
	return startTestCall(request, params.orgSlug)
}

export default function PhoneAgentTestRoute() {
	const { scopes, hasPublishedFlow, defaultFlow, liveKitConfigured, canStart } =
		useLoaderData<typeof loader>()
	const layout = useRouteLoaderData<typeof layoutLoader>(
		'routes/_app+/$orgSlug_+/phone-agent+/_layout',
	)
	const { orgSlug = '' } = useParams()

	return (
		<div className="flex flex-col gap-6">
			<PageHeader
				title={<Trans>Test call</Trans>}
				description={
					<Trans>
						Test your call flow from this browser and use the dial pad to press
						keys. Test calls use the same call flow, rules, and business
						details as real calls and appear in Calls marked as tests.
					</Trans>
				}
			/>
			{liveKitConfigured ? (
				<TestCallPanel
					orgSlug={orgSlug}
					scopes={scopes}
					hasPublishedFlow={hasPublishedFlow}
					defaultFlow={defaultFlow}
					canStart={canStart}
					regionSupported={layout?.regionSupported ?? true}
				/>
			) : (
				<div className="rounded-lg border border-dashed py-6">
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<Icon name="phone-off" />
							</EmptyMedia>
							<EmptyTitle>
								<Trans>Test calls aren't available yet</Trans>
							</EmptyTitle>
							<EmptyDescription>
								<Trans>
									The voice service for your account hasn't been set up. Contact
									support and we'll turn it on.
								</Trans>
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
				</div>
			)}
		</div>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
