/**
 * @vitest-environment jsdom
 */
import posthog from 'posthog-js'
import { describe, expect, it } from 'vitest'
import {
	POSTHOG_PRIVACY_OPTIONS,
	posthogInitOptions,
} from './posthog-config.ts'

const options = posthogInitOptions({
	apiHost: 'https://eu.i.posthog.example',
	hostname: 'app.example.test',
	nodeEnv: 'production',
	commitSha: 'abc123',
})

describe('App PostHog options', () => {
	it('turns off every feature that sends on-screen text', () => {
		expect(POSTHOG_PRIVACY_OPTIONS).toEqual({
			autocapture: false,
			rageclick: false,
			capture_dead_clicks: false,
			capture_heatmaps: false,
			disable_session_recording: true,
		})
		expect(options).toMatchObject(POSTHOG_PRIVACY_OPTIONS)
	})

	it('keeps page views, page leaves and exceptions, opted out until consent', () => {
		expect(options).toMatchObject({
			api_host: 'https://eu.i.posthog.example',
			capture_pageview: 'history_change',
			capture_pageleave: true,
			capture_exceptions: true,
			opt_out_capturing_by_default: true,
			person_profiles: 'identified_only',
		})
	})

	// Guards against an SDK upgrade or a newer `defaults` date that ignores or
	// overrides the explicit options.
	it('the installed SDK keeps them off after init', () => {
		const client = posthog.init(
			'phc_test_project_token',
			{
				...options,
				// No network in a unit test.
				advanced_disable_flags: true,
				disable_compression: true,
				disable_surveys: true,
			},
			'privacy-test',
		)
		expect(client).toBeDefined()
		const config = client!.config
		expect(config.autocapture).toBe(false)
		expect(config.rageclick).toBe(false)
		expect(config.capture_dead_clicks).toBe(false)
		expect(config.capture_heatmaps).toBe(false)
		expect(config.disable_session_recording).toBe(true)
		expect(client!.has_opted_out_capturing()).toBe(true)
		expect(client!.sessionRecordingStarted()).toBe(false)
	})
})
