import { PostHogProvider } from '@posthog/react'
import {
	TRACE_ID_GLOBAL,
	TraceIdProvider,
	generateTraceId,
	installTraceIdFetch,
	parseTraceId,
} from '@repo/common/trace-id'
import { i18n, I18nProvider, detect, fromHtmlTag } from '@repo/i18n'
import posthog from 'posthog-js'
import { startTransition } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { HydratedRouter } from 'react-router/dom'
import { ENV } from 'varlock/env'
import { loadCatalog } from './modules/lingui/lingui'
import { posthogInitOptions } from './utils/posthog-config.ts'

const posthogProjectToken = ENV.POSTHOG_PROJECT_TOKEN
const posthogEnabled = Boolean(
	posthogProjectToken?.startsWith('phc_') && ENV.POSTHOG_HOST,
)

if (posthogEnabled && posthogProjectToken) {
	posthog.init(
		posthogProjectToken,
		posthogInitOptions({
			apiHost: ENV.POSTHOG_HOST,
			hostname: window.location.hostname,
			nodeEnv: ENV.NODE_ENV,
			commitSha: ENV.COMMIT_SHA,
		}),
	)
}

// Logged-out visitors get `204 X-Remix-Reload-Document` from `/__manifest` for
// private routes (see `app/utils/private-client-code.server.ts`), and React
// Router answers with a document load. It remembers that reload in this key and
// refuses a second one for the same build, which would turn a later click on a
// private link into a client-side 404. A fresh document is a clean start.
try {
	sessionStorage.removeItem('react-router-manifest-version')
} catch {
	// Storage can be blocked; React Router then never sets the key either.
}

// The page-load trace id (#385): the server wrote it into the document; it
// rides on every same-origin request from here on.
const traceId =
	parseTraceId(
		(window as unknown as Record<string, unknown>)[TRACE_ID_GLOBAL],
	) ?? generateTraceId()
installTraceIdFetch(traceId)

const locale = detect(fromHtmlTag('lang')) || 'en'

await loadCatalog(locale)

// Start hydration immediately - translations will be available soon
startTransition(() => {
	const app = (
		<I18nProvider i18n={i18n}>
			<TraceIdProvider value={traceId}>
				<HydratedRouter />
			</TraceIdProvider>
		</I18nProvider>
	)

	hydrateRoot(
		document,
		posthogEnabled ? (
			<PostHogProvider client={posthog}>{app}</PostHogProvider>
		) : (
			app
		),
	)
})
