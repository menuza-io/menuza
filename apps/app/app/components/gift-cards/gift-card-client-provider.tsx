import { createContext, type ReactNode, useContext, useMemo } from 'react'
import {
	createGiftCardClient,
	type GiftCardClient,
} from '#app/utils/gift-cards/gift-card-client.ts'

const GiftCardClientContext = createContext<GiftCardClient | null>(null)

export function GiftCardClientProvider({
	orgSlug,
	children,
}: {
	orgSlug: string
	children: ReactNode
}) {
	const client = useMemo(() => createGiftCardClient({ orgSlug }), [orgSlug])
	return (
		<GiftCardClientContext.Provider value={client}>
			{children}
		</GiftCardClientContext.Provider>
	)
}

/** The typed regional gift card client for the current organization. */
export function useGiftCardClient(): GiftCardClient {
	const client = useContext(GiftCardClientContext)
	if (!client) {
		throw new Error('useGiftCardClient must be used within a GiftCardClientProvider')
	}
	return client
}
