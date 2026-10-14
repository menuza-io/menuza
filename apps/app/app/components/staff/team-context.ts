import { createContext, useContext } from 'react'
import { useOutletContext } from 'react-router'
import { type StaffScope } from '#app/utils/staffing/staff-scopes.ts'
import { type StaffPositionRow } from '#app/utils/staffing/staff-types.ts'

/** What the Team roster hands to its wizard sheets, and the profile page provides itself. */
export type StaffTeamContext = {
	orgSlug: string
	/** `/:orgSlug/staff/team` */
	basePath: string
	dataRegion: 'us' | 'ksa'
	scopes: StaffScope[]
	positions: StaffPositionRow[]
	/** Refetch the roster list after a change in a sheet. */
	reloadRoster: () => void
	/** Refetch the roster's onboarding progress after a checklist changed. */
	reloadOnboarding: () => void
	/** Refetch positions after one was added or archived. */
	reloadPositions: () => void
	/** Close the sheet. */
	close: () => void
}

/**
 * The profile page is a page of its own, not a child of the roster's sheet, so
 * it provides the same values through React context. The roster's wizard
 * sheets still receive them through the outlet.
 */
const TeamReactContext = createContext<StaffTeamContext | null>(null)
export const StaffTeamContextProvider = TeamReactContext.Provider

export function useTeamContext(): StaffTeamContext {
	const provided = useContext(TeamReactContext)
	const outlet = useOutletContext<StaffTeamContext | undefined>()
	const value = provided ?? outlet
	if (!value) {
		throw new Error('useTeamContext needs the Team roster or a profile page')
	}
	return value
}
