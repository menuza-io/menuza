import { Outlet, useLoaderData, useOutletContext } from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { LoyaltyChrome } from '#app/components/loyalty/loyalty-chrome.tsx'
import { LoyaltyClientProvider } from '#app/components/loyalty/loyalty-client-provider.tsx'
import { requireLoyaltyAccess } from '#app/utils/loyalty/access.server.ts'
import {
	computeLoyaltyNavAccess,
	type LoyaltyNavAccess,
} from '#app/utils/loyalty/nav.ts'
import { type Route } from './+types/_layout.ts'

export type LoyaltyLayoutContext = {
	orgSlug: string
	nav: LoyaltyNavAccess
}

export function useLoyaltyLayoutData(): LoyaltyLayoutContext {
	return useOutletContext<LoyaltyLayoutContext>()
}

export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireLoyaltyAccess(request, params.orgSlug)
	const nav = computeLoyaltyNavAccess(access.features, access.grants)
	if (!nav.visible) {
		throw new Response('Forbidden: requires loyalty access', { status: 403 })
	}
	return { orgSlug: access.orgSlug, nav }
}

export default function LoyaltyLayout() {
	const { orgSlug, nav } = useLoaderData<typeof loader>()
	const context: LoyaltyLayoutContext = { orgSlug, nav }
	return (
		<LoyaltyClientProvider orgSlug={orgSlug}>
			<LoyaltyChrome orgSlug={orgSlug} nav={nav}>
				<Outlet context={context} />
			</LoyaltyChrome>
		</LoyaltyClientProvider>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
