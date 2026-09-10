import { isCloudflareWorkerRuntime } from '@repo/common'
import { getInstanceInfo, getInternalInstanceDomain } from '@repo/common/litefs'
import { ENV } from './package-env.js'

export async function updatePrimaryCacheValue({
	key,
	cacheValue,
}: {
	key: string
	cacheValue: any
}) {
	if (isCloudflareWorkerRuntime()) {
		return new Response(null, { status: 204 })
	}

	const { currentIsPrimary, primaryInstance } = await getInstanceInfo()
	if (currentIsPrimary) {
		throw new Error(
			`updatePrimaryCacheValue should not be called on the primary instance (${primaryInstance})}`,
		)
	}
	const domain = getInternalInstanceDomain(primaryInstance)
	const token = ENV.INTERNAL_COMMAND_TOKEN
	return fetch(`${domain}/cache/sqlite`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ key, cacheValue }),
	})
}
