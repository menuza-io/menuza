import { type PostHogConfig } from 'posthog-js'

/**
 * PostHog features that would send what is on screen. App pages show guest
 * names, phones and emails (Customers, Reservations, Marketing), and PostHog
 * is not a regional host, so none of these may run:
 *
 * - `autocapture`: `$autocapture` events carry the clicked element's text
 *   (`$el_text`) and attributes.
 * - `rageclick` and `capture_dead_clicks`: their events carry the same
 *   element chain and text.
 * - `capture_heatmaps`: click and scroll positions per element.
 * - `disable_session_recording`: replay records the page itself.
 *
 * They are set explicitly so an SDK upgrade or a newer `defaults` date cannot
 * turn one on (see docs/monitoring.md, "What is collected").
 */
export const POSTHOG_PRIVACY_OPTIONS = {
	autocapture: false,
	rageclick: false,
	capture_dead_clicks: false,
	capture_heatmaps: false,
	disable_session_recording: true,
} as const satisfies Partial<PostHogConfig>

/**
 * Options for the App's `posthog.init`: page views, page leaves, exceptions
 * and logs, opted out until the analytics consent cookie is accepted. The
 * privacy options always win.
 */
export function posthogInitOptions(params: {
	apiHost: string | undefined
	hostname: string
	nodeEnv: string | undefined
	commitSha: string | undefined
}) {
	return {
		api_host: params.apiHost,
		defaults: '2026-05-30',
		capture_exceptions: true,
		capture_pageview: 'history_change',
		capture_pageleave: true,
		opt_out_capturing_by_default: true,
		person_profiles: 'identified_only',
		tracing_headers: [params.hostname, 'localhost'],
		logs: {
			serviceName: 'app-web',
			environment: params.nodeEnv,
			serviceVersion: params.commitSha || undefined,
			captureConsoleLogs: false,
		},
		...POSTHOG_PRIVACY_OPTIONS,
	} as const satisfies Partial<PostHogConfig>
}
