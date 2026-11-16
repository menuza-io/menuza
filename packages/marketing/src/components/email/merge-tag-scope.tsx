import { createContext, useContext, type ReactNode } from 'react'

/**
 * Which merge tags an editor offers. The loyalty tags (`{{pointsBalance}}`,
 * `{{rewardName}}`, `{{pointsToNextReward}}`) only have a value in a loyalty
 * automation, so everywhere else they stay out of the list.
 */
type MergeTagScope = { loyalty: boolean; cart?: boolean }

const MergeTagScopeContext = createContext<MergeTagScope>({ loyalty: false, cart: false })

export function MergeTagScopeProvider({
	loyalty,
	cart = false,
	children,
}: {
	loyalty: boolean
	/** The cart reminder automation: `{{cartLink}}` has a value there (#150). */
	cart?: boolean
	children: ReactNode
}) {
	return (
		<MergeTagScopeContext.Provider value={{ loyalty, cart }}>
			{children}
		</MergeTagScopeContext.Provider>
	)
}

export function useMergeTagScope(): MergeTagScope {
	return useContext(MergeTagScopeContext)
}
