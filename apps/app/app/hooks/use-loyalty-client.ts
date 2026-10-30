import { useContext } from 'react'
import { LoyaltyClientContext } from '#app/components/loyalty/loyalty-client-provider.tsx'
import { type LoyaltyClient } from '#app/utils/loyalty/loyalty-client.ts'

/** The typed regional loyalty client for the current organization. */
export function useLoyaltyClient(): LoyaltyClient {
	const context = useContext(LoyaltyClientContext)
	if (!context) {
		throw new Error(
			'useLoyaltyClient must be used within a LoyaltyClientProvider',
		)
	}
	return context.client
}
