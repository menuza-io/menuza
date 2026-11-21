// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRoutesStub } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	type CalendarBroadcast,
	type CalendarOccasion,
} from '#app/utils/marketing/calendar.server.ts'
import { MarketingCalendarGrid, OccasionList } from './marketing-calendar.tsx'

beforeEach(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

const mothers: CalendarOccasion = {
	key: 'us_mothers_day',
	date: '2026-05-10',
	year: 2026,
	expected: false,
	sendDate: '2026-04-30',
	sendAt: '2026-04-30T10:00:00.000Z',
	status: 'open',
	campaignId: null,
	skipReason: null,
	autoSchedule: false,
	autoChannel: 'email',
	preview: {
		subject: "Mother's Day at Casa Verde",
		body: 'x',
		sms: 'y',
		social: 'z',
	},
}
const ramadan: CalendarOccasion = {
	...mothers,
	key: 'ksa_ramadan_start',
	date: '2026-02-18',
	expected: true,
	preview: { ...mothers.preview, subject: 'Start of Ramadan at Casa Verde' },
}

function renderList(
	occasions: CalendarOccasion[],
	options: {
		canWrite?: boolean
		action?: ReturnType<typeof vi.fn<(request: Request) => Promise<unknown>>>
	} = {},
) {
	const action =
		options.action ?? vi.fn(async (_request: Request) => ({ ok: true }))
	const Stub = createRoutesStub([
		{
			path: '/acme/marketing/calendar',
			HydrateFallback: () => null,
			action: ({ request }) => action(request),
			Component: () => (
				<OccasionList
					occasions={occasions}
					orgSlug="acme"
					canWrite={options.canWrite ?? true}
				/>
			),
		},
	])
	render(
		<I18nProvider i18n={i18n}>
			<Stub initialEntries={['/acme/marketing/calendar']} />
		</I18nProvider>,
	)
	return action
}

describe('the marketing calendar (#152)', () => {
	it('shows an occasion with its ready-made subject, and "Use this" opens a prefilled broadcast', async () => {
		renderList([mothers])
		const card = await screen.findByTestId('occasion-us_mothers_day')
		expect(within(card).getByText("Mother's Day")).toBeTruthy()
		expect(within(card).getByText("Mother's Day at Casa Verde")).toBeTruthy()
		expect(within(card).getByText(/Sunday, May 10, 2026/)).toBeTruthy()
		const use = within(card).getByRole('button', { name: 'Use this' })
		expect(use.getAttribute('href')).toBe(
			'/acme/marketing/campaigns/new?occasion=us_mothers_day&date=2026-05-10',
		)
		expect(
			within(card)
				.getByRole('button', { name: 'Social post' })
				.getAttribute('href'),
		).toBe('/acme/marketing/social/new?occasion=us_mothers_day&date=2026-05-10')
		expect(within(card).queryByText('Expected')).toBeNull()
	})

	it('marks a Hijri date as expected', async () => {
		renderList([ramadan])
		const card = await screen.findByTestId('occasion-ksa_ramadan_start')
		expect(within(card).getByText('Expected')).toBeTruthy()
		expect(
			within(card).getByText(/Expected Wednesday, February 18, 2026/),
		).toBeTruthy()
	})

	it('Dismiss and Auto-schedule post the choice, and Auto-schedule starts off', async () => {
		const user = userEvent.setup()
		const action = renderList([mothers])
		const card = await screen.findByTestId('occasion-us_mothers_day')
		const toggle = within(card).getByRole('switch', {
			name: /Auto-schedule Mother's Day/,
		})
		expect(toggle.getAttribute('aria-checked')).toBe('false')
		await user.click(toggle)
		await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(1))
		const auto = Object.fromEntries(
			await (action.mock.calls[0]![0] as Request).formData(),
		)
		expect(auto).toMatchObject({
			intent: 'auto',
			key: 'us_mothers_day',
			on: 'true',
			channel: 'email',
		})
		await user.click(within(card).getByRole('button', { name: 'Dismiss' }))
		await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(2))
		expect(
			Object.fromEntries(
				await (action.mock.calls[1]![0] as Request).formData(),
			),
		).toEqual({
			intent: 'dismiss',
			key: 'us_mothers_day',
			year: '2026',
		})
	})

	it('someone who can only read sees the occasion, with no way to use or change it', async () => {
		renderList([mothers], { canWrite: false })
		const card = await screen.findByTestId('occasion-us_mothers_day')
		expect(within(card).queryByRole('button', { name: 'Use this' })).toBeNull()
		expect(within(card).queryByRole('button', { name: 'Dismiss' })).toBeNull()
		expect(within(card).queryByRole('switch')).toBeNull()
	})

	it('an occasion already scheduled says so and opens its broadcast; a skipped one says why', async () => {
		renderList([
			{
				...mothers,
				status: 'scheduled',
				campaignId: 'camp_1',
				autoSchedule: true,
			},
			{ ...ramadan, status: 'skipped', skipReason: 'occasion_conflict' },
		])
		const scheduled = await screen.findByTestId('occasion-us_mothers_day')
		expect(within(scheduled).getByText(/Scheduled automatically/)).toBeTruthy()
		expect(
			within(scheduled)
				.getByRole('button', { name: 'Open the broadcast' })
				.getAttribute('href'),
		).toBe('/acme/marketing/campaigns/camp_1')
		const skipped = screen.getByTestId('occasion-ksa_ramadan_start')
		expect(
			within(skipped).getByText(
				/another broadcast is already scheduled within 2 days/,
			),
		).toBeTruthy()
	})

	it('an empty list says there is nothing in the next four weeks', async () => {
		renderList([])
		expect(
			await screen.findByText('No occasions in the next four weeks.'),
		).toBeTruthy()
	})
})

describe('the month grid', () => {
	it('puts occasions, scheduled broadcasts and social posts on their days', async () => {
		const broadcasts: CalendarBroadcast[] = [
			{
				id: 'b1',
				name: 'Brunch special',
				channel: 'email',
				status: 'Scheduled',
				at: '2026-05-03T10:00:00.000Z',
			},
		]
		const Stub = createRoutesStub([
			{
				path: '/acme/marketing/calendar',
				HydrateFallback: () => null,
				Component: () => (
					<MarketingCalendarGrid
						month="2026-05"
						today="2026-05-01"
						timeZone="UTC"
						orgSlug="acme"
						occasions={[mothers]}
						broadcasts={broadcasts}
						posts={[
							{
								id: 'p1',
								body: 'New patio',
								status: 'scheduled',
								at: '2026-05-10T12:00:00.000Z',
								platforms: ['facebook'],
								accounts: [],
								imageUrl: null,
							},
						]}
					/>
				),
			},
		])
		render(
			<I18nProvider i18n={i18n}>
				<Stub initialEntries={['/acme/marketing/calendar']} />
			</I18nProvider>,
		)
		const tenth = await screen.findByRole('listitem', {
			name: /Sunday, May 10, 2026/,
		})
		expect(within(tenth).getByText("Mother's Day")).toBeTruthy()
		expect(
			within(tenth)
				.getByRole('link', { name: /New patio/ })
				.getAttribute('href'),
		).toBe('/acme/marketing/social/p1')
		const third = screen.getByRole('listitem', { name: /Sunday, May 3, 2026/ })
		expect(
			within(third)
				.getByRole('link', { name: /Brunch special/ })
				.getAttribute('href'),
		).toBe('/acme/marketing/campaigns/b1')
	})
})
