import { type LoaderFunctionArgs, redirect } from 'react-router'
import { getStaffingAccess } from '#app/utils/staffing/access.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const access = await getStaffingAccess(request, params.orgSlug)
	if (!access.flags.enabled) throw new Response('Not found', { status: 404 })
	const base = `/${params.orgSlug}/staffing`
	if (access.grants.staff) return redirect(`${base}/team`)
	if (access.grants.schedule) return redirect(`${base}/schedule`)
	if (access.grants.timeclock) return redirect(`${base}/timesheets`)
	throw new Response('Forbidden', { status: 403 })
}
