import {
	kdsFeedSchema,
	type KdsCommand,
	type KdsConfig,
} from '@repo/common/kds'
import { POS_STAFF_SESSION_HEADER } from '@repo/common/pos-orders'
import { noteServerDate } from '~/lib/clock.ts'
import { type PosSettings } from '~/lib/config.ts'
import { serversProblem } from '~/lib/pairing.ts'
import { type Session } from '~/lib/signin.ts'

export class KitchenError extends Error {
	constructor(
		readonly code: string,
		readonly status = 0,
	) {
		super(code)
	}
}

export function createKitchenApi(
	settings: PosSettings,
	session: Session | null,
	fetchImpl = fetch,
) {
	async function call(method: string, path: string, body?: unknown) {
		if (!settings.deviceToken) throw new KitchenError('invalid_device', 401)
		if (!settings.tenantApiUrl || serversProblem([settings.tenantApiUrl]))
			throw new KitchenError('invalid_server', 400)
		const sentAt = Date.now()
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), 8_000)
		try {
			const response = await fetchImpl(
				`${settings.tenantApiUrl.replace(/\/+$/, '')}/pos/kds${path}`,
				{
					method,
					cache: 'no-store',
					credentials: 'omit',
					headers: {
						Authorization: `Bearer ${settings.deviceToken}`,
						...(body ? { 'Content-Type': 'application/json' } : {}),
						...(session?.serverSession
							? { [POS_STAFF_SESSION_HEADER]: session.serverSession.token }
							: {}),
					},
					...(body ? { body: JSON.stringify(body) } : {}),
					signal: controller.signal,
				},
			)
			noteServerDate(response, sentAt)
			const raw: unknown = await response.json().catch(() => null)
			if (!response.ok) {
				const error =
					raw && typeof raw === 'object' && 'error' in raw
						? String(raw.error)
						: 'kitchen_unavailable'
				throw new KitchenError(error, response.status)
			}
			const parsed = kdsFeedSchema.safeParse(raw)
			if (!parsed.success) throw new KitchenError('invalid_response', 502)
			return parsed.data
		} catch (failure) {
			if (failure instanceof KitchenError) throw failure
			throw new KitchenError('connection_lost')
		} finally {
			clearTimeout(timeout)
		}
	}
	return {
		feed: () => call('GET', ''),
		command: (command: KdsCommand) => call('POST', '/command', command),
		configure: (expectedVersion: number, config: KdsConfig) =>
			call('PUT', '/settings', { expectedVersion, config }),
	}
}
