import { redirect } from 'react-router'
import { requireInventoryAccess } from '#app/utils/inventory/access.server.ts'
import { inventoryTabPath } from '#app/utils/inventory/nav.ts'
import { type Route } from './+types/_index.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireInventoryAccess(request, params.orgSlug)
	const url = new URL(request.url)
	return redirect(
		`${inventoryTabPath(access.organizationSlug, 'today')}${url.search}`,
	)
}

export default function InventoryIndexRoute() {
	return null
}
