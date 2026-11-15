import { describe, expect, it } from 'vitest'
import {
	evaluateLaunchCondition,
	isLocationLive,
	LAUNCH_CONDITIONS,
	LAUNCH_STEPS,
	launchStepState,
	type LocationLaunchFacts,
} from './launch.ts'

function facts(
	overrides: Partial<LocationLaunchFacts> = {},
): LocationLaunchFacts {
	return {
		hasAddress: true,
		hasHours: true,
		hasFullCategory: true,
		menuHealthOk: true,
		hasLogo: true,
		hasTheme: true,
		onlinePayments: false,
		payAtPickupOnly: true,
		hasChannel: true,
		prepTimeSet: true,
		terminalPaired: null,
		hasCountedOrder: null,
		customDomainActive: false,
		sitePublished: true,
		orderingOn: true,
		locationActive: true,
		sellableItems: 3,
		...overrides,
	}
}

describe('LAUNCH_STEPS', () => {
	it('has the nine steps, each with its own condition', () => {
		expect(LAUNCH_STEPS).toHaveLength(9)
		expect(LAUNCH_STEPS.map((step) => step.condition).sort()).toEqual(
			[...LAUNCH_CONDITIONS].sort(),
		)
	})

	it('makes only the terminal, test order and custom domain optional', () => {
		expect(
			LAUNCH_STEPS.filter((step) => step.optional).map(
				(step) => step.condition,
			),
		).toEqual(['terminalPaired', 'testOrderDone', 'customDomainActive'])
	})

	it('shares the organization-wide steps across locations', () => {
		expect(
			LAUNCH_STEPS.filter((step) => step.organizationWide).map(
				(step) => step.condition,
			),
		).toEqual([
			'brandingDone',
			'paymentsReady',
			'testOrderDone',
			'customDomainActive',
		])
	})
})

describe('evaluateLaunchCondition', () => {
	it('needs an address and opening hours for the location step', () => {
		expect(evaluateLaunchCondition('locationHasHours', facts())).toBe(true)
		expect(
			evaluateLaunchCondition('locationHasHours', facts({ hasHours: false })),
		).toBe(false)
	})

	it('needs a full category and a menu health of 60 or more', () => {
		expect(evaluateLaunchCondition('menuReady', facts())).toBe(true)
		expect(
			evaluateLaunchCondition('menuReady', facts({ menuHealthOk: false })),
		).toBe(false)
		expect(
			evaluateLaunchCondition('menuReady', facts({ hasFullCategory: false })),
		).toBe(false)
	})

	it('takes payments connected or pay at pickup chosen', () => {
		expect(
			evaluateLaunchCondition(
				'paymentsReady',
				facts({ onlinePayments: true, payAtPickupOnly: false }),
			),
		).toBe(true)
		expect(
			evaluateLaunchCondition(
				'paymentsReady',
				facts({ onlinePayments: false, payAtPickupOnly: false }),
			),
		).toBe(false)
	})

	it('treats an unanswered region as not done (optional steps only)', () => {
		expect(evaluateLaunchCondition('terminalPaired', facts())).toBe(false)
		expect(
			evaluateLaunchCondition(
				'terminalPaired',
				facts({ terminalPaired: true }),
			),
		).toBe(true)
	})
})

describe('isLocationLive', () => {
	it('is live without a paid order or the optional steps', () => {
		expect(
			isLocationLive(
				facts({
					hasCountedOrder: false,
					terminalPaired: false,
					customDomainActive: false,
				}),
			),
		).toBe(true)
	})

	it('loses live when any live rule breaks', () => {
		for (const broken of [
			{ sitePublished: false },
			{ orderingOn: false },
			{ locationActive: false },
			{ sellableItems: 0 },
			{ onlinePayments: false, payAtPickupOnly: false },
			// A required step undone: hours deleted.
			{ hasHours: false },
			{ menuHealthOk: false },
		]) {
			expect(isLocationLive(facts(broken))).toBe(false)
		}
	})
})

describe('launchStepState', () => {
	it('separates done, to do, optional and skipped', () => {
		expect(launchStepState({ optional: false }, true, false)).toBe('done')
		expect(launchStepState({ optional: false }, false, true)).toBe('todo')
		expect(launchStepState({ optional: true }, false, false)).toBe('optional')
		expect(launchStepState({ optional: true }, false, true)).toBe('skipped')
		expect(launchStepState({ optional: true }, true, true)).toBe('done')
	})
})
