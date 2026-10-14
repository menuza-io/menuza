import {
	createKioskApi,
	KioskApiError,
	KioskNetworkError,
} from './kiosk-api.ts'
import { saveKioskDevice, type StoredKioskDevice } from './kiosk-device.ts'

export type TenantApiUrls = { us: string; ksa: string }

export type PairResult =
	| { ok: true; device: StoredKioskDevice; serverNow: number }
	| { ok: false; code: string; retryAfterSeconds?: number }

/**
 * Pairs this browser with a one-time code and remembers the result. With a
 * known region (the link's fragment) only that node is asked. With a bare code
 * both are tried: the code names its organization, so only the right node
 * accepts it, and a wrong guess costs one refused request, nothing else.
 */
export async function pairKiosk(
	urls: TenantApiUrls,
	code: string,
	region?: 'us' | 'ksa',
): Promise<PairResult> {
	const order: Array<'us' | 'ksa'> = region ? [region] : ['us', 'ksa']
	let last: PairResult = { ok: false, code: 'invalid_pairing_code' }
	for (const candidate of order) {
		const tenantApiUrl = urls[candidate]
		try {
			const paired = await createKioskApi({ tenantApiUrl }).pair(code)
			const device: StoredKioskDevice = {
				deviceSecret: paired.deviceSecret,
				tenantApiUrl,
				config: { device: paired.device, scope: paired.scope },
			}
			if (!saveKioskDevice(device)) {
				return { ok: false, code: 'storage_unavailable' }
			}
			return { ok: true, device, serverNow: paired.serverNow }
		} catch (error) {
			if (error instanceof KioskNetworkError) {
				return { ok: false, code: 'network_unavailable' }
			}
			if (error instanceof KioskApiError) {
				last = {
					ok: false,
					code: error.code,
					retryAfterSeconds: error.retryAfterSeconds,
				}
				if (error.code !== 'invalid_pairing_code') return last
			}
		}
	}
	return last
}
