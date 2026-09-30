import { type Integration } from '../database-types'
import { providerRegistry } from '../provider.ts'
import { isPosIntegrationProvider } from './providers/index.ts'
import { type RemoteLocation } from './remote-location.ts'
import { isPosProvider, type PosProvider } from './types.ts'

export async function readRemoteLocation(
	integration: Integration,
): Promise<RemoteLocation | null> {
	if (!isPosProvider(integration.providerName)) return null
	const provider = providerRegistry.get(integration.providerName)
	if (!isPosIntegrationProvider(provider)) return null
	const adapter = await provider.adapter(integration)
	return adapter.readLocation()
}
