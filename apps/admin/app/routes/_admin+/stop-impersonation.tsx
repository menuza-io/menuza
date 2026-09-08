import { stopImpersonation } from '@repo/auth'

export async function action({ request }: { request: Request }) {
	return stopImpersonation(request, '/users')
}
