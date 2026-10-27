import { redirect, type LoaderFunctionArgs } from 'react-router'
import { requireQrOrderingAccess } from '#app/utils/qr/access.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const access = await requireQrOrderingAccess(request, params.orgSlug)
	return redirect(`/${access.organization.slug}/settings/qr-tables`)
}
