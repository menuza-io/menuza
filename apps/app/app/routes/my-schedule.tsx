import { useLoaderData } from 'react-router'
import { MySchedulePage } from '#app/components/my-schedule/my-schedule-page.tsx'
import { resolveRegionalTenantApiUrls } from '#app/utils/tenant-api.server.ts'
import { type Route } from './+types/my-schedule.ts'

/**
 * A person's own schedule, outside the signed-in app. They arrive from the link
 * in their schedule email: `/my-schedule#r=<region>&t=<token>`. The token lives
 * in the URL fragment, which no server receives, and the page talks to the
 * regional node directly, so nothing about the person passes through this
 * server. The loader only names the two regional nodes (public values).
 *
 * Like the time clock it asks for no cookies and runs no analytics (the root
 * layout skips both for routes whose `handle` says `kiosk`), and it tells
 * browsers not to send a referrer, so the page can never leak where it was
 * opened from.
 */
export const handle = { kiosk: true }

export const meta: Route.MetaFunction = () => [
	{ title: 'My schedule' },
	{ name: 'robots', content: 'noindex, nofollow' },
	{ name: 'referrer', content: 'no-referrer' },
]

export function loader() {
	return {
		urls: {
			us: resolveRegionalTenantApiUrls('us').tenantApiUrl,
			ksa: resolveRegionalTenantApiUrls('ksa').tenantApiUrl,
		},
	}
}

export default function MyScheduleRoute() {
	const { urls } = useLoaderData<typeof loader>()
	return (
		<div className="bg-background text-foreground min-h-dvh">
			<MySchedulePage urls={urls} />
		</div>
	)
}
