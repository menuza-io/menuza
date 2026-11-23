import { requireUserWithRole } from '@repo/auth'
import { type LoaderFunctionArgs, redirect } from 'react-router'
import { getSignedGetRequestInfoAsync } from '#app/utils/storage.server.ts'
import { getScreenshotKey } from '#app/utils/support-requests.server.ts'

/** Opens the request's screenshot through a short-lived signed link (Admin only). */
export async function loader({ request, params }: LoaderFunctionArgs) {
	await requireUserWithRole(request, 'admin')
	const key = await getScreenshotKey(params.requestId ?? '')
	if (!key) throw new Response('Not found', { status: 404 })
	const { url } = await getSignedGetRequestInfoAsync(key)
	return redirect(url, { headers: { 'Cache-Control': 'private, no-store' } })
}
