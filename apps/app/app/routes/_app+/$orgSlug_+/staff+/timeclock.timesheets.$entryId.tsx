import { EditCardSheet } from '#app/components/staff/timesheets/card-sheet.tsx'
import { requireTimesheetsAccess } from '#app/utils/staffing/timesheets-access.server.ts'
import { type Route } from './+types/timeclock.timesheets.$entryId.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireTimesheetsAccess(request, params.orgSlug)
	return null
}

export default function StaffTimeCardRoute({ params }: Route.ComponentProps) {
	return <EditCardSheet entryId={params.entryId} />
}
