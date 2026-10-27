import { WorkspacePage } from '@repo/ui/workspace'
import { Outlet, type LoaderFunctionArgs } from 'react-router'
import { requireQrOrderingAccess } from '#app/utils/qr/access.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	await requireQrOrderingAccess(request, params.orgSlug)
	return null
}

export default function QrOrderingLayout() {
	return (
		<WorkspacePage>
			<Outlet />
		</WorkspacePage>
	)
}
