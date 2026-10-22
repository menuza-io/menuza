import { useOperatorClient } from '#app/hooks/use-operator-client.ts'

/** App returns credentials only. Order and contact data never transit App SSR. */
export function useOrdersClient(orgSlug: string) {
	return useOperatorClient(orgSlug, '/operator/orders').request
}
