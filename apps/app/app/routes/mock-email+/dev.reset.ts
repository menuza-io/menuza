import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import {
	requireMockEmailEnabled,
	resetCapturedEmails,
} from '#app/utils/dev-email-capture.server.ts'

export async function loader(_args: LoaderFunctionArgs) {
	requireMockEmailEnabled()
	return new Response('Method Not Allowed', { status: 405 })
}

/** Dev only: `POST /mock-email/dev/reset` clears the captured emails. 404 without `MOCKS=true`. */
export async function action({ request }: ActionFunctionArgs) {
	requireMockEmailEnabled()
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	await resetCapturedEmails()
	return Response.json({ success: true })
}
