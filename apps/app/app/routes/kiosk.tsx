import { Outlet, useLoaderData } from 'react-router'
import { useKioskServiceWorker } from '#app/hooks/use-kiosk-service-worker.ts'
import { resolveRegionalTenantApiUrls } from '#app/utils/tenant-api.server.ts'
import { type Route } from './+types/kiosk.ts'

/**
 * The shared-tablet time clock shell, outside the signed-in app.
 *
 * No loader here touches a person, a session or a database: it only names the
 * two regional nodes the browser may call (public values). The page is a client
 * app; it talks to the regional time clock directly with the paired tablet's
 * device secret, so no name, PIN or punch passes through this server. Pairing
 * lives in the URL fragment (`/kiosk/pair#r=us&c=...`), which browsers never
 * send to a server.
 *
 * The root layout skips the cookie banner and analytics for routes whose
 * `handle` says `kiosk` (a clock on a counter should not ask for cookies).
 */
export const handle = { kiosk: true }

export const meta: Route.MetaFunction = () => [
	{ title: 'Time clock' },
	{ name: 'robots', content: 'noindex, nofollow' },
]

export function loader() {
	return {
		urls: {
			us: resolveRegionalTenantApiUrls('us').tenantApiUrl,
			ksa: resolveRegionalTenantApiUrls('ksa').tenantApiUrl,
		},
	}
}

export default function KioskLayout() {
	const { urls } = useLoaderData<typeof loader>()
	useKioskServiceWorker()
	return (
		<div className="bg-background text-foreground flex h-dvh min-h-0 flex-col overflow-hidden">
			<Outlet context={{ urls }} />
		</div>
	)
}
