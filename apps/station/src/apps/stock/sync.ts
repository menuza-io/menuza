import { createStockApi, type StockApi } from './api.ts'
import { demoStockApi } from './demo.ts'
import { stockOrigin } from './local.ts'
import { flushStock, type FlushResult } from './runner.ts'
import { type PosSettings } from '~/lib/config.ts'
import { type Session } from '~/lib/signin.ts'

/** The region the Stock app talks to: the paired terminal's node, or demo mode's in-memory one. */
export function stockApiFor(
	settings: PosSettings,
	session: Pick<Session, 'serverSession'> | null,
): StockApi {
	return settings.demo ? demoStockApi() : createStockApi(settings, session)
}

/**
 * Sends the Stock outbox for the person signed in now (the till's own sync
 * calls it with the other uploads). Nothing to do for a terminal that does not
 * offer Stock (what waits stays on the tablet) or one that is not paired.
 */
export async function syncStock(
	settings: PosSettings,
	session: Session | null,
	online: boolean,
	options: {
		force?: boolean
		onUnpaired?: () => void
		onUnrecognised?: () => void
	} = {},
): Promise<FlushResult | null> {
	if (!settings.apps.inventory) return null
	if (!settings.demo && (!settings.deviceToken || !settings.tenantApiUrl))
		return null
	return flushStock({
		api: stockApiFor(settings, session),
		origin: stockOrigin(settings),
		hasSession: settings.demo || Boolean(session?.serverSession),
		online: online || settings.demo,
		demo: settings.demo,
		...options,
	})
}
