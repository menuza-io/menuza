import { createContext, type ReactNode, useMemo } from 'react'
import {
	type OperatorRequestInit,
	useOperatorClient,
} from '#app/hooks/use-operator-client.ts'

export type InventoryClient = {
	orgSlug: string
	/**
	 * Calls `/operator/inventory<path>` on the organization's regional
	 * tenant-api with a short-lived `inv+jwt` (read for GET, write otherwise).
	 * Throws `OperatorRequestError` on a non-2xx answer. `readOnly: true` marks
	 * a POST that only reads (recipe costs) so it uses the read token.
	 */
	request: (path: string, init?: OperatorRequestInit) => Promise<unknown>
}

export const InventoryClientContext = createContext<InventoryClient | null>(
	null,
)

/**
 * One inventory client per Inventory layout mount, so cached tokens never
 * outlive a sign-out or an organization switch. Stock and staff data go
 * browser-direct to the region; they never transit App SSR.
 */
export function InventoryClientProvider({
	orgSlug,
	children,
}: {
	orgSlug: string
	children: ReactNode
}) {
	const { request } = useOperatorClient(
		orgSlug,
		'/operator/inventory',
		'inventory-token',
	)
	const value = useMemo<InventoryClient>(
		() => ({ orgSlug, request }),
		[orgSlug, request],
	)
	return (
		<InventoryClientContext.Provider value={value}>
			{children}
		</InventoryClientContext.Provider>
	)
}
