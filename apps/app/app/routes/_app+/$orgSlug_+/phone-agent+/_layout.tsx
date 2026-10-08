import { Trans } from '@lingui/macro'
import { Icon } from '@repo/ui/icon'
import {
	Item,
	ItemContent,
	ItemDescription,
	ItemMedia,
	ItemTitle,
} from '@repo/ui/item'
import { Outlet, useLoaderData, useLocation } from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { requirePhoneAgentSectionAccess } from '#app/utils/phone-agent/access.server.ts'
import { getLiveKitConfig } from '#app/utils/phone-agent/livekit.server.ts'
import { type Route } from './+types/_layout.ts'

// Each page checks its own permission: setup pages need phone agent read,
// the Calls page needs call read.
export async function loader({ request, params }: Route.LoaderArgs) {
	const { dataRegion } = await requirePhoneAgentSectionAccess(
		request,
		params.orgSlug,
	)
	return {
		regionSupported: dataRegion === 'us',
		liveKitConfigured: Boolean(getLiveKitConfig()),
	}
}

export default function PhoneAgentLayout() {
	const { regionSupported } = useLoaderData<typeof loader>()
	const location = useLocation()

	// The flow editor renders full-viewport, like the automation builder.
	if (/\/phone-agent\/flow\/?$/.test(location.pathname)) {
		return <Outlet />
	}

	return (
		<div className="mx-auto flex w-full max-w-6xl flex-col gap-6 py-8 md:px-6 lg:px-8">
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
			<Outlet />
		</div>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
