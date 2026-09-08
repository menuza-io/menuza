import {
	setCookieConsentState,
	verifyCookieConsentRequestOrigin,
} from '@repo/common/cookie-consent'
import { type ActionFunctionArgs } from 'react-router'

export async function action({ request }: ActionFunctionArgs) {
	if (!verifyCookieConsentRequestOrigin(request)) {
		return Response.json({ error: 'Invalid origin' }, { status: 403 })
	}

	const formData = await request.formData()
	const consent = formData.get('consent') === 'true'
	const cookie = await setCookieConsentState(consent)

	const headers = new Headers()
	headers.append('Set-Cookie', cookie)

	return Response.json({ success: true }, { headers })
}
