import { Trans } from '@lingui/react/macro'
import { useMemo } from 'react'
import { useLoaderData } from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { SetupChecksPanel } from '#app/components/inventory/setup-checks-panel.tsx'
import { requireInventoryAccess } from '#app/utils/inventory/access.server.ts'
import { loadMenuNames } from '#app/utils/inventory/menu-names.server.ts'
import { type Route } from './+types/setup-check.ts'
import { useInventoryLayoutData } from './_layout.tsx'

export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireInventoryAccess(request, params.orgSlug)
	// The region names dishes by id; the App joins their names from the menu.
	return {
		menu: access.features.recipes
			? await loadMenuNames(access.organizationId)
			: { dishes: [], options: [] },
	}
}

/**
 * "Check your setup" in full (#510): every finding with its evidence and fix.
 * Today shows the first few and links here.
 */
export default function InventorySetupCheckRoute() {
	const { orgSlug, activeLocationId, canEdit, canManagePurchasing, currency } =
		useInventoryLayoutData()
	const loaderData = useLoaderData<typeof loader>() as
		Awaited<ReturnType<typeof loader>> | undefined
	const names = useMemo(
		() => ({
			dishes: new Map(
				loaderData?.menu.dishes.map((dish) => [dish.id, dish.name]),
			),
			options: new Map(
				loaderData?.menu.options.map((option) => [option.id, option.name]),
			),
		}),
		[loaderData?.menu],
	)
	return (
		<div className="flex flex-col gap-4" data-testid="inventory-setup-check">
			<p className="text-muted-foreground text-sm">
				<Trans>
					Things in your stock setup that are probably mistakes. Fix them in a
					tap, or tell us they are right and we will stop asking until they
					change.
				</Trans>
			</p>
			<SetupChecksPanel
				orgSlug={orgSlug}
				locationId={activeLocationId}
				names={names}
				currency={currency}
				canEdit={canEdit}
				canManagePurchasing={canManagePurchasing}
			/>
		</div>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
