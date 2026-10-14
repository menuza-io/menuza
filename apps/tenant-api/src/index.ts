import 'varlock/auto-load'
import { serve } from '@hono/node-server'
import { ENV } from 'varlock/env'
import { createTenantApiApp } from './app.ts'
import { registerRestaurantOrderSource } from './restaurant/staffing-order-source.ts'
import { assertDataRegion, getNodeRegion } from './lib/region.ts'
import { assertTenantApiSecrets } from './lib/secrets.ts'
import { startStaffTickInterval } from './lib/staff-tick-interval.ts'

assertTenantApiSecrets()
assertDataRegion()

registerRestaurantOrderSource()

const app = createTenantApiApp()

const port = Number(ENV.PORT) || 3007
const region = getNodeRegion()

console.log(
	`Regional Tenant Node (${region}) running on http://localhost:${port}`,
)

serve({
	fetch: app.fetch,
	port,
})

// Sub-hourly staff tick on this node; the hourly cron remains the safety net.
startStaffTickInterval()
