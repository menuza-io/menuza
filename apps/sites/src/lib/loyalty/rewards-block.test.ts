// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { type LoyaltyPublicProgram } from '@repo/loyalty'
import { describe, expect, it } from 'vitest'
import { initRewardsBlock } from './rewards-block'
import { testProgram, testWallet } from './test-fixtures'
import { testLoyaltyLabels } from './test-labels'

function makeProgram(
	overrides: Partial<LoyaltyPublicProgram> = {},
): LoyaltyPublicProgram {
	return testProgram({
		welcomeBonus: {
			enabled: true,
			points: 25,
			afterFirstPaidOrder: false,
		},
		tiers: {
			metric: 'qualifying_points',
			periodMonths: 12,
			graceDays: 14,
			levels: [
				{
					id: 'tier_gold',
					name: 'Gold',
					threshold: 500,
					multiplierBp: 15_000,
				},
			],
		},
		...overrides,
	})
}

describe('initRewardsBlock', () => {
	const labels = testLoyaltyLabels()

	it('renders heading, welcome bonus, tiers, rewards, and Join CTA when signed out', async () => {
		const root = document.createElement('section')
		root.hidden = true
		await initRewardsBlock(root, {
			client: {
				program: async () => makeProgram(),
			},
			labels,
			locale: 'en',
			signedIn: () => false,
			loginHref: '/login?redirect=%2Fprofile%2Frewards',
			walletHref: '/profile/rewards',
			config: {
				heading: 'Earn Free Coffee',
				body: 'Collect points on every order.',
				ctaLabel: 'Join Rewards',
				showRewards: true,
				showTiers: true,
			},
		})

		expect(root.hidden).toBe(false)
		expect(root.querySelector('h2')?.textContent).toBe('Earn Free Coffee')
		const cta = root.querySelector<HTMLAnchorElement>(
			'[data-loyalty-block-cta]',
		)
		expect(cta?.textContent).toBe('Join Rewards')
		expect(cta?.getAttribute('href')).toBe(
			'/login?redirect=%2Fprofile%2Frewards',
		)
		expect(root.querySelector('[data-loyalty-block-welcome]')).not.toBeNull()
		expect(
			root.querySelector('[data-loyalty-block-tiers]')?.textContent,
		).toContain('Gold')
		expect(root.querySelector('[data-loyalty-block-rewards]')).not.toBeNull()
	})

	it('links signed-in members directly to their rewards wallet and shows their balance', async () => {
		const root = document.createElement('section')
		root.hidden = true
		await initRewardsBlock(root, {
			client: {
				program: async () => makeProgram(),
				wallet: async () =>
					testWallet({
						program: makeProgram(),
						balance: { points: 240, reserved: 0, available: 240 },
					}),
			},
			labels,
			locale: 'en',
			signedIn: () => true,
			loginHref: '/login',
			walletHref: '/profile/rewards',
		})

		expect(root.hidden).toBe(false)
		const cta = root.querySelector<HTMLAnchorElement>(
			'[data-loyalty-block-cta]',
		)
		expect(cta?.getAttribute('href')).toBe('/profile/rewards')
		expect(cta?.textContent).toBe(labels.blockView)
		expect(
			root.querySelector('[data-loyalty-block-balance]')?.textContent,
		).toContain('240')
	})

	it('stays hidden when program is paused or null', async () => {
		const root = document.createElement('section')
		root.hidden = true
		await initRewardsBlock(root, {
			client: {
				program: async () => makeProgram({ status: 'paused' }),
			},
			labels,
			locale: 'en',
			signedIn: () => false,
			loginHref: '/login',
			walletHref: '/profile/rewards',
		})
		expect(root.hidden).toBe(true)
		expect(root.children).toHaveLength(0)
	})
})
