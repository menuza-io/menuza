import { stopImpersonation } from '@repo/auth'
import { getOperatorAdminUrl } from '@repo/common/cookie-domain'
import { ENV } from 'varlock/env'

export async function action({ request }: { request: Request }) {
	const adminUsersUrl = `${getOperatorAdminUrl(ENV.BASE_URL, ENV.ROOT_APP)}/users`
	return stopImpersonation(request, adminUsersUrl)
}
