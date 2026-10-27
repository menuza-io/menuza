import { useOperatorClient } from '#app/hooks/use-operator-client.ts'

/** Browser-direct `/operator/qr/*` calls; tab guest details never transit App. */
export function useQrClient(orgSlug: string) {
	return useOperatorClient(orgSlug, '/operator/qr', 'qr-token').request
}
