import { type PosSettings } from './config.ts'
import { serversProblem } from './pairing.ts'

/**
 * Sends a till order's kitchen ticket or receipt to the location's cloud
 * printers again (#117). Answers true when a printer took it: the tablet then
 * opens no print dialog. Any failure (offline, no printer, demo) answers false,
 * and the tablet prints through its own dialog as it always did.
 */
export async function reprintToCloud(
	settings: Pick<PosSettings, 'deviceToken' | 'tenantApiUrl' | 'demo'>,
	input: { orderId: string; kind: 'kitchen' | 'receipt' },
	fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
	if (settings.demo || !settings.deviceToken) return false
	if (!settings.tenantApiUrl || serversProblem([settings.tenantApiUrl]))
		return false
	if (typeof navigator !== 'undefined' && navigator.onLine === false) return false
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), 6_000)
	try {
		const response = await fetchImpl(
			`${settings.tenantApiUrl.replace(/\/+$/, '')}/pos/print/reprint`,
			{
				method: 'POST',
				cache: 'no-store',
				credentials: 'omit',
				headers: {
					Authorization: `Bearer ${settings.deviceToken}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					orderId: input.orderId,
					kind: input.kind,
					requestId: crypto.randomUUID(),
				}),
				signal: controller.signal,
			},
		)
		if (!response.ok) return false
		const body: unknown = await response.json().catch(() => null)
		return (
			Boolean(body) &&
			typeof body === 'object' &&
			(body as { cloudPrinted?: unknown }).cloudPrinted === true
		)
	} catch {
		return false
	} finally {
		clearTimeout(timeout)
	}
}
