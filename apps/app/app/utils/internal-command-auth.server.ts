import crypto from 'node:crypto'
import { getInstanceInfo } from '@repo/common/litefs'
import { assertSecretNotPlaceholder } from '@repo/security'
import { ENV } from 'varlock/env'

function safeCompare(
	a: string | null | undefined,
	b: string | null | undefined,
): boolean {
	if (!a || !b) return false
	const hashA = crypto.createHash('sha256').update(a).digest()
	const hashB = crypto.createHash('sha256').update(b).digest()
	return crypto.timingSafeEqual(hashA, hashB)
}

export async function requireInternalCommandAuth(request: Request) {
	const { currentIsPrimary, primaryInstance } = await getInstanceInfo()
	if (!currentIsPrimary) {
		throw new Error(
			`${request.url} should only be called on the primary instance (${primaryInstance})`,
		)
	}

	const token = ENV.INTERNAL_COMMAND_TOKEN
	assertSecretNotPlaceholder('INTERNAL_COMMAND_TOKEN', token ?? '')
	const authHeader = request.headers.get('Authorization')
	const isAuthorized = safeCompare(authHeader, `Bearer ${token}`)
	if (!isAuthorized) {
		throw Response.json(
			{ error: 'Unauthorized' },
			{
				status: 401,
				headers: {
					'WWW-Authenticate': 'Bearer',
					'Cache-Control': 'no-store',
				},
			},
		)
	}
}
