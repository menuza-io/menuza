import { type ActionFunctionArgs } from 'react-router'
import { __setMockLaunchStatus } from '#app/utils/env.server.ts'

function isLocalHostname(hostname: string) {
	return (
		hostname === 'localhost' ||
		hostname === '127.0.0.1' ||
		hostname === '[::1]' ||
		hostname.endsWith('.localhost') ||
		hostname.endsWith('.test')
	)
}

export async function action({ request }: ActionFunctionArgs) {
	const hostname = new URL(request.url).hostname
	// MOCKS on a public host must not expose this switch.
	if (
		!isLocalHostname(hostname) ||
		(process.env.NODE_ENV === 'production' && !process.env.MOCKS)
	) {
		throw new Response('Not Found', { status: 404 })
	}
	const formData = await request.formData()
	const status = formData.get('status')
	__setMockLaunchStatus(status ? String(status) : null)
	return Response.json({ success: true })
}
