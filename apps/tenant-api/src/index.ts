import 'varlock/auto-load'
import { serve } from '@hono/node-server'
import { ENV } from 'varlock/env'
import { createTenantApiApp } from './app.ts'
import {
	captureDevEmail,
	devEmailCaptureDir,
	isDevEmailCaptureOn,
} from './lib/dev-email-capture.ts'
import { assertConsentBaseUrl } from './lib/email-consent.ts'
import { assertDataRegion, getNodeRegion } from './lib/region.ts'
import { assertTenantApiSecrets } from './lib/secrets.ts'
import { setTenantEmailDevCapture } from './lib/tenant-email.ts'
import { startStaffTickInterval } from './lib/staff-tick-interval.ts'

assertTenantApiSecrets()
assertConsentBaseUrl()
assertDataRegion()

if (process.env.NODE_ENV === 'production' && devEmailCaptureDir()) {
	console.warn('DEV_EMAIL_CAPTURE_DIR is ignored in production')
}
if (isDevEmailCaptureOn()) {
	setTenantEmailDevCapture((record) =>
		captureDevEmail(record, { region: getNodeRegion() }),
	)
	console.log(`DEV EMAIL CAPTURE ACTIVE -> ${devEmailCaptureDir()}`)
}

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
