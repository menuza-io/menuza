import { useOutletContext } from 'react-router'
import { type ApplicantScope } from '#app/utils/hiring/applicant-types.ts'

export type { ApplicantScope }

/** What the applicants page hands to the candidate sheet route. */
export type ApplicantsContext = {
	orgSlug: string
	/** `/:orgSlug/staff/hiring/applicants` */
	basePath: string
	/** The page's own query string (`?view=list&stage=offer`), kept on every link. */
	search: string
	scopes: ApplicantScope[]
	canWrite: boolean
	/** The signed-in member's id, so their own notes read "You". */
	userId: string
	/** Whether this member may invite the new hire to the app after hiring. */
	canInvite: boolean
	/** Refetch the pipeline after a change in the sheet. */
	reload: () => void
	/** Close the sheet. */
	close: () => void
}

export function useApplicantsContext(): ApplicantsContext {
	return useOutletContext<ApplicantsContext>()
}
