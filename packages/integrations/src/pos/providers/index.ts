import { BasePosProvider, type PosIntegrationProvider } from './base.ts'
import { CloverProvider } from './clover.ts'
import { DoorDashProvider } from './doordash.ts'
import { SquareProvider } from './square.ts'
import { ToastProvider } from './toast.ts'
import { UberEatsProvider } from './ubereats.ts'

export { BasePosProvider, type PosIntegrationProvider }
export {
	CloverProvider,
	DoorDashProvider,
	SquareProvider,
	ToastProvider,
	UberEatsProvider,
}

/** Every POS/delivery provider class, in display order. */
export function createPosProviders(): BasePosProvider[] {
	return [
		new CloverProvider(),
		new SquareProvider(),
		new ToastProvider(),
		new UberEatsProvider(),
		new DoorDashProvider(),
	]
}

export function isPosIntegrationProvider(
	provider: unknown,
): provider is PosIntegrationProvider {
	return (
		!!provider &&
		typeof provider === 'object' &&
		'kind' in provider &&
		'readCatalog' in provider
	)
}
