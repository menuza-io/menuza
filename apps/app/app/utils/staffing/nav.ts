/** Which links of the sidebar "Staff" group the current member should see. */
export type StaffingNavAccess = {
	visible: boolean
	team: boolean
	timeclock: boolean
	schedule: boolean
	labor: boolean
	hiring: boolean
}

export const HIDDEN_STAFFING_NAV: StaffingNavAccess = {
	visible: false,
	team: false,
	timeclock: false,
	schedule: false,
	labor: false,
	hiring: false,
}
