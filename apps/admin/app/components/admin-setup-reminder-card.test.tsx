// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { fireEvent, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import { type SetupReminderAnswer } from '#app/utils/setup-reminder.ts'
import { AdminSetupReminderCard } from './admin-setup-reminder-card.tsx'

beforeEach(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

function renderCard(
	answers: Record<'preview' | 'send', SetupReminderAnswer>,
	history = [] as Parameters<typeof AdminSetupReminderCard>[0]['history'],
) {
	const router = createMemoryRouter(
		[
			{
				path: '/',
				element: (
					<AdminSetupReminderCard organizationId="org_1" history={history} />
				),
			},
			{
				path: '/organizations/:id/setup-reminder',
				action: async ({ request }) => {
					const form = await request.formData()
					return { answer: answers[form.get('intent') as 'preview' | 'send'] }
				},
			},
		],
		{ initialEntries: ['/'] },
	)
	render(
		<I18nProvider i18n={i18n}>
			<RouterProvider router={router} />
		</I18nProvider>,
	)
}

const preview: SetupReminderAnswer = {
	status: 'ok',
	subject: 'Next step for Acme: Add your menu',
	heading: 'Add your menu, about 15 minutes',
	intro: 'You started setting up Acme.',
	progress: '2 of 6 done',
	actionLabel: 'Continue setup',
	locale: 'en',
	recipients: 1,
	nextManualAt: null,
}

describe('AdminSetupReminderCard (#271)', () => {
	it('previews the reminder, then sends it now', async () => {
		renderCard({ preview, send: { status: 'sent', recipients: 1 } })
		fireEvent.click(screen.getByRole('button', { name: 'Preview reminder' }))
		expect(await screen.findByTestId('reminder-preview')).toBeTruthy()
		expect(screen.getByText('Add your menu, about 15 minutes')).toBeTruthy()
		expect(screen.getByText('2 of 6 done')).toBeTruthy()
		fireEvent.click(screen.getByRole('button', { name: 'Send reminder now' }))
		expect((await screen.findByTestId('reminder-sent')).textContent).toContain(
			'sent to 1 owner',
		)
	})

	it('says "Nobody to notify" when no owner can receive it', async () => {
		renderCard({
			preview: { status: 'nobody_to_notify' },
			send: { status: 'nobody_to_notify' },
		})
		fireEvent.click(screen.getByRole('button', { name: 'Preview reminder' }))
		expect((await screen.findByTestId('reminder-nobody')).textContent).toBe(
			'Nobody to notify',
		)
	})

	it('disables the send button while the daily limit is in force', async () => {
		renderCard({
			preview: { ...preview, nextManualAt: '2027-02-04T10:00:00.000Z' },
			send: { status: 'limit', nextAt: '2027-02-04T10:00:00.000Z' },
		})
		fireEvent.click(screen.getByRole('button', { name: 'Preview reminder' }))
		const send = await screen.findByRole('button', {
			name: 'Send reminder now',
		})
		expect(send).toBeDisabled()
	})

	it('lists the history of reminders sent', () => {
		renderCard({ preview, send: { status: 'failed' } }, [
			{
				id: 'a',
				kind: 'manual',
				day: null,
				stepKey: 'launch_menu',
				doneCount: 2,
				totalCount: 6,
				recipientCount: 1,
				sentAt: '2027-02-03T10:00:00.000Z',
			},
			{
				id: 'b',
				kind: 'auto',
				day: 3,
				stepKey: 'launch_location_details',
				doneCount: 0,
				totalCount: 6,
				recipientCount: 1,
				sentAt: '2027-02-02T03:00:00.000Z',
			},
		])
		const rows = screen.getAllByTestId('reminder-history-row')
		expect(rows).toHaveLength(2)
		expect(rows[0]?.textContent).toContain('Menu')
		expect(rows[0]?.textContent).toContain('Manual')
		expect(rows[1]?.textContent).toContain('Day 3')
	})

	it('says so when nothing was sent yet', () => {
		renderCard({ preview, send: { status: 'failed' } })
		expect(screen.getByText('No reminders sent yet.')).toBeTruthy()
	})
})
