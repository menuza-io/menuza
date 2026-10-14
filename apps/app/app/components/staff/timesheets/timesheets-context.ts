import { useOutletContext } from 'react-router'
import { type StaffPositionRow } from '#app/utils/staffing/staff-types.ts'
import { type ApprovalMode } from '#app/utils/staffing/timesheet-view.ts'

export type TimesheetScope = {
	id: string
	/** Already in the operator's language. */
	name: string
	timeZone: string
}

/** What the Timesheets list hands to the card sheets that open over it. */
export type TimesheetsContext = {
	orgSlug: string
	/** `/:orgSlug/staff/timeclock/timesheets` */
	basePath: string
	/** The list's own address bar (`?view=...`), kept when a sheet opens or closes. */
	search: string
	scopes: TimesheetScope[]
	positions: StaffPositionRow[]
	can: {
		/** `update:timesheet:any`: add, edit, void, mark reviewed. */
		update: boolean
		/** `approve:timesheet:any`: approve, lock, unlock, reopen. */
		approve: boolean
		/** `read:staff_pay:any`: tips and rates. */
		money: boolean
	}
	approvalMode: (scopeId: string) => ApprovalMode
	/** Where and when a new card starts, from what the list is showing. */
	defaultScopeId: string
	defaultDate: string
	/** The server's clock, as far as this tab can tell. */
	now: () => number
	/** Refetch the list after a change in a sheet. */
	reload: () => void
	/** Close the sheet and return to the list. */
	close: () => void
}

export function useTimesheetsContext(): TimesheetsContext {
	return useOutletContext<TimesheetsContext>()
}
