import { createContext, type ReactNode, useEffect, useMemo } from 'react'
import {
	createLoyaltyClient,
	createLoyaltyClientPool,
	type LoyaltyClient,
	type LoyaltyClientPool,
} from '#app/utils/loyalty/loyalty-client.ts'

export type LoyaltyClientContextValue = {
	pool: LoyaltyClientPool
	client: LoyaltyClient
}

export const LoyaltyClientContext =
	createContext<LoyaltyClientContextValue | null>(null)

export function LoyaltyClientProvider({
	orgSlug,
	children,
}: {
	orgSlug: string
	children: ReactNode
}) {
	const value = useMemo<LoyaltyClientContextValue>(() => {
		const pool = createLoyaltyClientPool({ orgSlug })
		return { pool, client: createLoyaltyClient(pool) }
	}, [orgSlug])

	useEffect(() => {
		return () => {
			value.pool.invalidateAll()
		}
	}, [value])

	return (
		<LoyaltyClientContext.Provider value={value}>
			{children}
		</LoyaltyClientContext.Provider>
	)
}
