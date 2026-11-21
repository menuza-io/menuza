import { i18n } from '@lingui/core'
import { getFeatureFlag } from '@repo/common/feature-flags'
import { beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@repo/common/feature-flags', () => ({ getFeatureFlag: vi.fn() }))

import {
	pushStepError,
	triggerAccessFrom,
} from './automation-triggers.server.ts'
import {
	getMarketingFeatures,
	NO_MARKETING_FEATURES,
} from './marketing-flags.server.ts'

beforeAll(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

const node = (type: string) => ({ id: type, type, data: {} })
const on = { ...NO_MARKETING_FEATURES, push: true }

describe('the Send push step and the push flags (#105)', () => {
	it("needs marketing.push AND the app's customer_app.push", async () => {
		const set = (values: Record<string, unknown>) =>
			vi
				.mocked(getFeatureFlag)
				.mockImplementation(async (key: string) => values[key] as never)
		set({ 'marketing.push': true, 'customer_app.push': true })
		expect((await getMarketingFeatures('org')).push).toBe(true)
		set({ 'marketing.push': true })
		expect((await getMarketingFeatures('org')).push).toBe(false)
		set({ 'customer_app.push': true })
		expect((await getMarketingFeatures('org')).push).toBe(false)
		// Only a literal true counts.
		set({ 'marketing.push': 'yes', 'customer_app.push': 'yes' })
		expect((await getMarketingFeatures('org')).push).toBe(false)
	})

	it('offers the step only while push is on', () => {
		expect(triggerAccessFrom(on).pushSteps).toBe(true)
		expect(triggerAccessFrom(NO_MARKETING_FEATURES).pushSteps).toBe(false)
	})

	it('refuses to save a push step while push is off, but lets a journey that has one keep saving', () => {
		const nodes = [node('trigger'), node('action_push')]
		expect(pushStepError({ nodes, features: NO_MARKETING_FEATURES })).toMatch(
			/push/i,
		)
		expect(
			pushStepError({
				nodes,
				features: NO_MARKETING_FEATURES,
				storedNodes: [node('action_push')],
			}),
		).toBeNull()
		expect(pushStepError({ nodes, features: on })).toBeNull()
		expect(
			pushStepError({
				nodes: [node('trigger'), node('action_sms')],
				features: NO_MARKETING_FEATURES,
			}),
		).toBeNull()
	})
})
