// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import {
	type MenuHealthCheckSummary,
	type MenuHealthSummary,
} from '#app/utils/menu/menu-health.ts'
import { MenuHealthCard } from './menu-health-card.tsx'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

function check(
	overrides: Partial<MenuHealthCheckSummary> &
		Pick<MenuHealthCheckSummary, 'key' | 'entityType'>,
): MenuHealthCheckSummary {
	return {
		severity: 'warning',
		count: 0,
		total: 10,
		records: [],
		dismissedCount: 0,
		dismissed: [],
		...overrides,
	}
}

const HEALTH: MenuHealthSummary = {
	score: 84,
	grade: 'B',
	fixCount: 6,
	itemCount: 10,
	checks: [
		check({
			key: 'no_photo',
			entityType: 'item',
			count: 2,
			records: [
				{ id: 'i1', name: 'Falafel' },
				{ id: 'i2', name: 'Kunafa' },
			],
			dismissedCount: 1,
			dismissed: [{ id: 'i9', name: 'Tea' }],
		}),
		check({
			key: 'empty_category',
			entityType: 'category',
			count: 1,
			records: [{ id: 'c1', name: 'Desserts' }],
		}),
		check({
			key: 'impossible_minimum',
			entityType: 'modifier_group',
			severity: 'error',
			count: 3,
			records: [{ id: 'g1', name: 'Sauces' }],
		}),
	],
}

function renderCard(canEdit = true, health: MenuHealthSummary = HEALTH) {
	i18n.load('en', {})
	i18n.activate('en')
	const posts: unknown[] = []
	const router = createMemoryRouter(
		[
			{
				path: '/',
				element: (
					<I18nProvider i18n={i18n}>
						<MenuHealthCard
							health={health}
							orgSlug="acme"
							review={{ canEdit, translationLocales: [], autoTranslate: false }}
						/>
					</I18nProvider>
				),
			},
			{
				path: '/acme/menu/checks',
				action: async ({ request }) => {
					posts.push(await request.json())
					return { ok: true }
				},
			},
		],
		{ initialEntries: ['/'] },
	)
	render(<RouterProvider router={router} />)
	return posts
}

describe('MenuHealthCard', () => {
	it('shows the grade and how many things to fix', () => {
		renderCard()
		expect(screen.getByText('Grade')).toBeTruthy()
		expect(screen.getByText('B')).toBeTruthy()
		expect(screen.getByText('Good')).toBeTruthy()
		expect(screen.getByText(/6 things to fix/)).toBeTruthy()
	})

	it('lists records with edit links for each record type', async () => {
		renderCard()
		const user = userEvent.setup()
		await user.click(screen.getByText('2 dishes have no photo'))
		await user.click(screen.getByText('1 category is empty'))
		await user.click(
			screen.getByText('3 option groups require more picks than they allow'),
		)
		const href = (name: string) =>
			screen.getByRole('link', { name }).getAttribute('href')
		expect(href('Falafel')).toBe('/acme/menu/items/i1')
		expect(href('Desserts')).toBe('/acme/menu/categories/c1')
		expect(href('Sauces')).toBe('/acme/menu/modifiers/g1')
		expect(
			screen.getByRole('link', { name: /See all 3/ }).getAttribute('href'),
		).toBe('/acme/menu/modifiers?health=impossible_minimum')
	})

	it('posts a dismiss, and a restore from the dismissed list', async () => {
		const posts = renderCard()
		const user = userEvent.setup()
		await user.click(screen.getByText('2 dishes have no photo'))
		await user.click(
			screen.getByRole('button', { name: 'No photo on purpose: Falafel' }),
		)
		await waitFor(() => expect(posts).toHaveLength(1))
		expect(posts[0]).toEqual({
			intent: 'dismiss',
			checkKey: 'no_photo',
			entityId: 'i1',
			reason: 'on_purpose',
		})
		await user.click(screen.getByText('1 dismissed'))
		await user.click(screen.getByRole('button', { name: 'Restore: Tea' }))
		await waitFor(() => expect(posts).toHaveLength(2))
		expect(posts[1]).toEqual({
			intent: 'restore',
			checkKey: 'no_photo',
			entityId: 'i9',
		})
	})

	it('gives every row a button named after its record, with a described hint', async () => {
		renderCard()
		const user = userEvent.setup()
		await user.click(screen.getByText('2 dishes have no photo'))
		const falafel = screen.getByRole('button', {
			name: 'No photo on purpose: Falafel',
		})
		const kunafa = screen.getByRole('button', {
			name: 'No photo on purpose: Kunafa',
		})
		expect(falafel).not.toBe(kunafa)
		expect(falafel.getAttribute('aria-describedby')).toBeTruthy()
		const hint = document.getElementById(
			falafel.getAttribute('aria-describedby')!,
		)
		expect(hint?.textContent).toBe('Stays dismissed until this changes.')
	})

	it.each([
		[77, 'C', 'Needs work'],
		[55, 'F', 'Incomplete'],
		[95, 'A', 'Excellent'],
		[65, 'D', 'Needs work'],
	] as const)('score %s shows grade %s with %s', (score, grade, label) => {
		renderCard(true, { ...HEALTH, score, grade })
		expect(screen.getByText(grade)).toBeTruthy()
		expect(screen.getByText(label)).toBeTruthy()
	})

	it('does not claim every dish is complete when only dismissed items remain', () => {
		renderCard(true, {
			score: 100,
			grade: 'A',
			fixCount: 0,
			itemCount: 10,
			checks: [
				check({
					key: 'no_photo',
					entityType: 'item',
					dismissedCount: 2,
					dismissed: [
						{ id: 'i1', name: 'Falafel' },
						{ id: 'i2', name: 'Kunafa' },
					],
				}),
			],
		})
		expect(screen.getByText('Nothing left to fix. 2 dismissed.')).toBeTruthy()
		expect(screen.queryByText(/Every dish has a photo/)).toBeNull()
	})

	it('hides Dismiss and Restore without edit permission', async () => {
		renderCard(false)
		const user = userEvent.setup()
		await user.click(screen.getByText('2 dishes have no photo'))
		await user.click(screen.getByText('1 dismissed'))
		expect(screen.queryByRole('button', { name: /on purpose/ })).toBeNull()
		expect(screen.queryByRole('button', { name: /^Restore/ })).toBeNull()
		expect(screen.getByRole('link', { name: 'Tea' })).toBeTruthy()
	})
})
