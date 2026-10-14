import { NewCardSheet } from '#app/components/staff/timesheets/card-sheet.tsx'
import { requireTimesheetsAccess } from '#app/utils/staffing/timesheets-access.server.ts'
import { type Route } from './+types/timeclock.timesheets.new.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireTimesheetsAccess(request, params.orgSlug, { write: true })
	return null
}

export function shouldRevalidate() {
	return false
}

export default function StaffNewTimeCardRoute() {
	return <NewCardSheet />
}
