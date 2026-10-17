import { type LoaderFunctionArgs } from 'react-router'
import {
	listCapturedEmails,
	renderMailViewer,
	requireMockEmailEnabled,
} from '#app/utils/dev-email-capture.server.ts'

/** Dev only: lists the emails the Workers dev capture stored. 404 without `MOCKS=true`. */
export async function loader(_args: LoaderFunctionArgs) {
	requireMockEmailEnabled()
	const messages = await listCapturedEmails()
	return new Response(renderMailViewer(messages), {
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': 'no-store',
			'Content-Security-Policy':
				"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
		},
	})
}
