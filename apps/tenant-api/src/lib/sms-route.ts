import { getNodeRegion } from './region.ts'

/**
 * Whether this node may text guests at all: the US node only. The KSA node
 * has no in-kingdom SMS provider yet (#78), and `@repo/sms` refuses there too.
 */
export function smsRouteAvailable(): boolean {
	try {
		return getNodeRegion() === 'us'
	} catch {
		return false
	}
}
