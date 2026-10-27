import { redirect, type LoaderFunctionArgs } from 'react-router'
import { requireQrOrderingAccess } from '#app/utils/qr/access.server.ts'

/** QR ordering options moved to Settings; old links land there. */
export async function loader({ request, params }: LoaderFunctionArgs) {
	const access = await requireQrOrderingAccess(request, params.orgSlug)
	return redirect(`/${access.organization.slug}/settings/qr-ordering`)
}
