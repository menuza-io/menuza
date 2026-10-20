import { type RouteConfig } from '@react-router/dev/routes'
import { remixRoutesOptionAdapter } from '@react-router/remix-routes-option-adapter'
import { flatRoutes } from 'remix-flat-routes'

/**
 * Dev-only route folders. `build:cf` sets `STRIP_DEV_MOCKS=true`, so a deployed
 * Worker never contains them (each also answers 404 unless the payment mock is
 * on and the request is local).
 */
const DEV_MOCK_ROUTE_FOLDERS = ['mock-payments+']

export default remixRoutesOptionAdapter((defineRoutes) => {
	return flatRoutes('routes', defineRoutes, {
		ignoredRouteFiles: [
			'.*',
			'**/*.css',
			'**/*.test.{js,jsx,ts,tsx}',
			'**/__*.*',
			// This is for server-side utilities you want to colocate
			// next to your routes without making an additional
			// directory. If you need a route that includes "server" or
			// "client" in the filename, use the escape brackets like:
			// my-route.[server].tsx
			'**/*.server.*',
			'**/*.client.*',
			...(process.env.STRIP_DEV_MOCKS === 'true'
				? DEV_MOCK_ROUTE_FOLDERS.map((folder) => `${folder}/**`)
				: []),
		],
	})
}) satisfies RouteConfig
