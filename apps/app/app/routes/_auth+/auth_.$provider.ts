import { handleMockAction } from '@repo/auth'
import { ProviderNameSchema } from '@repo/auth/constants'
import { getReferrerRoute } from '@repo/common'
import { getRedirectCookieHeader } from '@repo/common/redirect-cookie'
import { redirect } from 'react-router'
import { authenticator } from '#app/utils/auth.server.ts'
import { type Route } from './+types/auth_.$provider.ts'

export async function loader() {
	return redirect('/login')
}

export async function action({ request, params }: Route.ActionArgs) {
	const providerName = ProviderNameSchema.parse(params.provider)

	try {
		await handleMockAction(providerName, request)
		return await authenticator.authenticate(providerName, request)
	} catch (error: unknown) {
		if (error instanceof Response) {
			const formData = await request.formData()
			const rawRedirectTo = formData.get('redirectTo')
			const redirectTo =
				typeof rawRedirectTo === 'string'
					? rawRedirectTo
					: getReferrerRoute(request)
			const redirectToCookie = getRedirectCookieHeader(redirectTo, request)
			if (redirectToCookie) {
				error.headers.append('set-cookie', redirectToCookie)
			}
		}
		throw error
	}
}
