import { redirect } from 'react-router'
import { requireLoyaltyAccess } from '#app/utils/loyalty/access.server.ts'
import { firstVisibleLoyaltyPath } from '#app/utils/loyalty/nav.ts'
import { type Route } from './+types/_index.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireLoyaltyAccess(request, params.orgSlug)
	const target =
		firstVisibleLoyaltyPath(access.orgSlug, access.features, access.grants) ??
		`/${access.orgSlug}/loyalty/overview`
	return redirect(target)
}

export default function LoyaltyIndexRoute() {
	return null
}
