import { createContext, useContext, type ReactNode } from 'react'

/**
 * Which merge tags an editor offers. The loyalty tags (`{{pointsBalance}}`,
 * `{{rewardName}}`, `{{pointsToNextReward}}`) only have a value in a loyalty
 * automation, so everywhere else they stay out of the list.
 */
type MergeTagScope = { loyalty: boolean }

const MergeTagScopeContext = createContext<MergeTagScope>({ loyalty: false })

export function MergeTagScopeProvider({
	loyalty,
	children,
}: {
	loyalty: boolean
	children: ReactNode
}) {
	return (
		<MergeTagScopeContext.Provider value={{ loyalty }}>
			{children}
		</MergeTagScopeContext.Provider>
	)
}

export function useMergeTagScope(): MergeTagScope {
	return useContext(MergeTagScopeContext)
}
