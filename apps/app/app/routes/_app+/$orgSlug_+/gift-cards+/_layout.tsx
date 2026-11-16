import { useLingui } from '@lingui/react/macro'
import { db, eq, OrganizationLocation } from '@repo/database'
import { PageHeader } from '@repo/ui/page-header'
import { WorkspacePage, WorkspaceTabBar } from '@repo/ui/workspace'
import { Outlet, useLoaderData, useLocation, useOutletContext } from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { GiftCardClientProvider } from '#app/components/gift-cards/gift-card-client-provider.tsx'
import { requireGiftCardAccess } from '#app/utils/gift-cards/access.server.ts'
import {
	computeGiftCardNavAccess,
	type GiftCardNavAccess,
} from '#app/utils/gift-cards/nav.ts'
import { type Route } from './+types/_layout.ts'

export type GiftCardLayoutContext = {
	orgSlug: string
	currency: 'USD' | 'SAR'
	nav: GiftCardNavAccess
	/** Names only: a location's name is not about a guest. */
	locations: Record<string, string>
}

export function useGiftCardLayout(): GiftCardLayoutContext {
	return useOutletContext<GiftCardLayoutContext>()
}

export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireGiftCardAccess(request, params.orgSlug)
	const nav = computeGiftCardNavAccess(access.features, access.grants)
	if (!nav.visible) {
		throw new Response('Forbidden: requires gift card access', { status: 403 })
	}
	const rows = await db
		.select({ id: OrganizationLocation.id, name: OrganizationLocation.name })
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.organizationId, access.organizationId))
		.limit(500)
	return {
		orgSlug: access.organizationSlug,
		currency: access.currency,
		nav,
		locations: Object.fromEntries(rows.map((row) => [row.id, row.name])),
	}
}

export default function GiftCardsLayout() {
	const { orgSlug, currency, nav, locations } = useLoaderData<typeof loader>()
	const { t } = useLingui()
	const location = useLocation()
	const base = `/${orgSlug}/gift-cards`
	const onSettings = location.pathname.startsWith(`${base}/settings`)
	const review = new URLSearchParams(location.search).get('needsReview') === 'true'
	const tabs = [
		{ label: t`Cards`, href: base, isActive: !onSettings && !review },
		...(nav.canManage
			? [
					{
						label: t`Needs review`,
						href: `${base}?needsReview=true`,
						isActive: !onSettings && review,
					},
					{ label: t`Settings`, href: `${base}/settings`, isActive: onSettings },
				]
			: []),
	]
	const context: GiftCardLayoutContext = { orgSlug, currency, nav, locations }
	return (
		<GiftCardClientProvider orgSlug={orgSlug}>
			<WorkspacePage>
				<PageHeader
					title={t`Gift cards`}
					description={t`Cards guests buy online and at the till, spend on orders, and you can charge from here. Balances and codes stay in your data region.`}
				/>
				<WorkspaceTabBar tabs={tabs} />
				<Outlet context={context} />
			</WorkspacePage>
		</GiftCardClientProvider>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
