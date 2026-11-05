import crypto from 'node:crypto'
import { cache } from '@repo/cache'
import { getInstanceInfo } from '@repo/common/litefs'
import { assertSecretNotPlaceholder } from '@repo/security'
import { ENV } from 'varlock/env'
import { z } from 'zod'
import { isCloudflareWorkerRuntime } from '#app/utils/runtime.server.ts'
import { type Route } from './+types/cache_.sqlite.ts'

function safeCompare(
	a: string | null | undefined,
	b: string | null | undefined,
): boolean {
	if (!a || !b) return false
	const hashA = crypto.createHash('sha256').update(a).digest()
	const hashB = crypto.createHash('sha256').update(b).digest()
	return crypto.timingSafeEqual(hashA, hashB)
}

export async function action({ request }: Route.ActionArgs) {
	if (!isCloudflareWorkerRuntime()) {
		const { currentIsPrimary, primaryInstance } = await getInstanceInfo()
		if (!currentIsPrimary) {
			throw new Error(
				`${request.url} should only be called on the primary instance (${primaryInstance})}`,
			)
		}
	}
	const token = ENV.INTERNAL_COMMAND_TOKEN
	// Same gate as App: a published placeholder must never authenticate.
	assertSecretNotPlaceholder('INTERNAL_COMMAND_TOKEN', token ?? '')
	const authHeader = request.headers.get('Authorization')
	const isAuthorized = safeCompare(authHeader, `Bearer ${token}`)
	if (!isAuthorized) {
		// nah, you can't be here...
		return Response.json(
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
	const { key, cacheValue } = z
		.object({ key: z.string(), cacheValue: z.unknown().optional() })
		.parse(await request.json())
	if (cacheValue === undefined) {
		await cache.delete(key)
	} else {
		// @ts-expect-error - we don't reliably know the type of cacheValue
		await cache.set(key, cacheValue)
	}
	return { success: true }
}
