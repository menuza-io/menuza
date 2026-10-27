import { redirect, type LoaderFunctionArgs } from 'react-router'
import { requireQrOrderingAccess } from '#app/utils/qr/access.server.ts'

/** QR tables moved to Settings; old links and bookmarks land there. */
export async function loader({ request, params }: LoaderFunctionArgs) {
	const access = await requireQrOrderingAccess(request, params.orgSlug)
	return redirect(`/${access.organization.slug}/settings/qr-tables`)
}
