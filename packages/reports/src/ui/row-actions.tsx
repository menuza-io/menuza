import { createContext, useContext } from 'react'

/** A link offered from one row of a list report (#261: open a dish, mark it unavailable). */
export type ReportRowAction = { label: string; href: string }

/**
 * What a screen offers from a list row: given the subject and the row's record
 * id (`__ref`), the links to show. Provided by the app around the workspace, so
 * the shared report screens carry no app routes. No provider: no actions.
 */
export type ReportRowActions = (input: {
	subject: string
	ref: string
}) => ReportRowAction[]

export const ReportRowActionsContext = createContext<ReportRowActions | null>(
	null,
)

export function useReportRowActions(): ReportRowActions | null {
	return useContext(ReportRowActionsContext)
}
