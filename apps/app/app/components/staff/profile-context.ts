import { useOutletContext } from 'react-router'
import { type StaffMemberRow } from '#app/utils/staffing/staff-types.ts'

/** What the profile route hands to its nested dialogs (terminate, rehire). */
export type StaffProfileContext = {
	staff: StaffMemberRow
	/** Reload the profile and the roster after a change. */
	onChanged: () => void
	/** Close the dialog and return to the profile. */
	close: () => void
}

export function useProfileContext(): StaffProfileContext {
	return useOutletContext<StaffProfileContext>()
}
