// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { PersonMarketingCard } from '#app/components/customers/person-marketing-card.tsx'
import {
	PeopleApiError,
	type PeopleClient,
	type PersonConsentResult,
	type PersonSubscription,
} from '#app/utils/people/people-api.ts'
import { renderStaff } from '#tests/staff-render.tsx'

const DAY = 24 * 60 * 60 * 1000

function sub(over: Partial<PersonSubscription> = {}): PersonSubscription {
	return {
		topic: 'marketing',
		channel: 'email',
		subscribed: true,
		subscribedAt: Date.UTC(2026, 9, 1),
		unsubscribedAt: null,
		source: 'checkout',
		unsubscribedSource: null,
		pending: false,
		staff: null,
		coolingOffUntil: null,
		...over,
	}
}

type Handler = (
	path: string,
	options?: { method?: string; body?: Record<string, unknown> },
) => unknown

function Harness({
	client,
	initial,
	canRecord = true,
	email = 'vera@example.test',
	phone = '+15555550100',
}: {
	client: PeopleClient
	initial: PersonSubscription[]
	canRecord?: boolean
	email?: string | null
	phone?: string | null
}) {
	const [subs, setSubs] = useState(initial)
	return (
		<PersonMarketingCard
			client={client}
			personKey="c_1"
			subscriptions={subs}
			email={email}
			phone={phone}
			hasCustomer
			canRecord={canRecord}
			memberNames={{ u1: 'Maya Manager' }}
			currentUserId="u9"
			onSubscription={(channel, next) =>
				setSubs((prev) => {
					const rest = prev.filter(
						(r) => !(r.topic === 'marketing' && r.channel === channel),
					)
					return next ? [...rest, next] : rest
				})
			}
		/>
	)
}

function setup(initial: PersonSubscription[], handler?: Handler, extra = {}) {
	const request = vi.fn(async (path: string, options?: never) => {
		const handled = handler?.(path, options)
		if (handled !== undefined) return handled
		return { subscription: null }
	})
	renderStaff(
		<Harness
			client={{ request } as unknown as PeopleClient}
			initial={initial}
			{...extra}
		/>,
	)
	return request
}

const emailSwitch = () =>
	screen.getByRole('switch', {
		hidden: true,
		name: 'Email marketing',
	})
const textSwitch = () =>
	screen.getByRole('switch', {
		hidden: true,
		name: 'Text marketing',
	})

describe('PersonMarketingCard states', () => {
	it('reflects on, off, unsubscribed and pending', () => {
		setup([
			sub({ source: 'checkout' }),
			sub({
				channel: 'sms',
				subscribed: false,
				unsubscribedAt: Date.UTC(2026, 9, 5),
				unsubscribedSource: 'self',
			}),
		])
		expect(emailSwitch()).toBeChecked()
		expect(screen.getByTestId('person-consent-email')).toHaveTextContent(
			'Subscribed on',
		)
		expect(screen.getByTestId('person-consent-email')).toHaveTextContent(
			'Checkout',
		)
		expect(textSwitch()).not.toBeChecked()
		expect(screen.getByTestId('person-consent-sms')).toHaveTextContent(
			'Unsubscribed by the guest on',
		)
	})

	it('says when staff turned it off, and tolerates legacy rows', () => {
		setup([
			sub({
				subscribed: false,
				unsubscribedAt: 1,
				unsubscribedSource: 'operator',
			}),
			sub({ channel: 'sms', subscribed: false, unsubscribedAt: 1 }),
		])
		expect(screen.getByTestId('person-consent-email')).toHaveTextContent(
			'Turned off by staff on',
		)
		expect(screen.getByTestId('person-consent-sms')).toHaveTextContent(
			/^Text\s*Unsubscribed on/,
		)
	})

	it('shows a pending staff-recorded email with the name and method', () => {
		setup([
			sub({
				source: 'staff',
				pending: true,
				staff: { recordedBy: 'u1', method: 'paper_form', textVersion: null },
			}),
		])
		const row = screen.getByTestId('person-consent-email')
		expect(row).toHaveTextContent('Recorded by staff')
		expect(row).toHaveTextContent('Pending')
		expect(row).toHaveTextContent('Waiting for the guest to confirm by email')
		expect(screen.getByTestId('person-consent-email-staff')).toHaveTextContent(
			'Recorded by Maya Manager on',
		)
		expect(screen.getByTestId('person-consent-email-staff')).toHaveTextContent(
			'Paper form',
		)
	})

	it('names an unknown member generically and the current user as you', () => {
		setup([
			sub({
				source: 'staff',
				staff: { recordedBy: 'gone', method: null, textVersion: null },
			}),
			sub({
				channel: 'sms',
				source: 'staff',
				staff: { recordedBy: 'u9', method: 'phone', textVersion: null },
			}),
		])
		expect(screen.getByTestId('person-consent-email-staff')).toHaveTextContent(
			'Recorded by a staff member on',
		)
		expect(screen.getByTestId('person-consent-sms-staff')).toHaveTextContent(
			'Recorded by you on',
		)
	})

	it('disables the switch during cooling-off', () => {
		setup([
			sub({
				subscribed: false,
				unsubscribedAt: 1,
				unsubscribedSource: 'self',
				coolingOffUntil: new Date(Date.now() + 5 * DAY).toISOString(),
			}),
		])
		expect(emailSwitch()).toHaveAttribute('aria-disabled', 'true')
		expect(screen.getByTestId('person-consent-email-hint')).toHaveTextContent(
			'The guest unsubscribed recently. You can record consent again after',
		)
	})

	it('disables a channel with no contact and says what to add', () => {
		setup([], undefined, { email: null, phone: null })
		expect(emailSwitch()).toHaveAttribute('aria-disabled', 'true')
		expect(textSwitch()).toHaveAttribute('aria-disabled', 'true')
		expect(screen.getByTestId('person-consent-email-hint')).toHaveTextContent(
			'Add an email address first',
		)
		expect(screen.getByTestId('person-consent-sms-hint')).toHaveTextContent(
			'Add a phone number first',
		)
	})

	it('is read-only without the permission but still shows state', () => {
		setup([sub()], undefined, { canRecord: false })
		expect(emailSwitch()).toBeChecked()
		expect(emailSwitch()).toHaveAttribute('aria-disabled', 'true')
		expect(textSwitch()).toHaveAttribute('aria-disabled', 'true')
	})

	it('keeps other topics read-only in a table', () => {
		setup([sub({ topic: 'reservations', source: 'reservation_booking' })])
		expect(
			screen.getByTestId('person-subscription-reservations-email'),
		).toHaveTextContent('Booking form')
	})
})

describe('PersonMarketingCard turning on', () => {
	const ok: PersonConsentResult = {
		subscription: sub({
			channel: 'sms',
			source: 'staff',
			staff: { recordedBy: 'u9', method: 'phone', textVersion: 'x' },
		}),
		deliverable: true,
		confirmationSms: 'sent',
	}

	it('needs a method and the attestation, sends the right body and updates the card', async () => {
		const request = setup([], (path) =>
			path === '/c_1/consent' ? ok : undefined,
		)
		fireEvent.click(textSwitch())
		const dialog = await screen.findByTestId('person-consent-dialog')
		expect(
			within(dialog).getByText('Record consent for text offers'),
		).toBeInTheDocument()
		const confirm = screen.getByTestId('person-consent-confirm')
		expect(confirm).toBeDisabled()
		expect(textSwitch()).not.toBeChecked()
		fireEvent.click(screen.getByRole('radio', { name: 'By phone' }))
		expect(confirm).toBeDisabled()
		fireEvent.click(screen.getByRole('checkbox'))
		expect(confirm).toBeEnabled()
		fireEvent.click(confirm)
		await waitFor(() =>
			expect(request).toHaveBeenCalledWith('/c_1/consent', {
				method: 'POST',
				body: {
					channel: 'sms',
					subscribed: true,
					method: 'phone',
					attested: true,
					textVersion: 'staff-2026-11',
				},
			}),
		)
		await waitFor(() => expect(textSwitch()).toBeChecked())
		expect(screen.queryByTestId('person-consent-dialog')).toBeNull()
		expect(screen.getByTestId('person-consent-sms-staff')).toHaveTextContent(
			'Recorded by you on',
		)
	})

	it('Cancel leaves the switch off and sends nothing', async () => {
		const request = setup([])
		fireEvent.click(emailSwitch())
		await screen.findByTestId('person-consent-dialog')
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
		await waitFor(() =>
			expect(screen.queryByTestId('person-consent-dialog')).toBeNull(),
		)
		expect(emailSwitch()).not.toBeChecked()
		expect(request).not.toHaveBeenCalled()
	})

	it('explains cooling_off with the date and keeps the dialog open', async () => {
		setup([], () => {
			throw new PeopleApiError(
				'x',
				409,
				'cooling_off',
				'2026-12-01T00:00:00.000Z',
			)
		})
		fireEvent.click(emailSwitch())
		await screen.findByTestId('person-consent-dialog')
		fireEvent.click(screen.getByRole('radio', { name: 'In person' }))
		fireEvent.click(screen.getByRole('checkbox'))
		fireEvent.click(screen.getByTestId('person-consent-confirm'))
		expect(await screen.findByTestId('person-consent-error')).toHaveTextContent(
			'You can record consent again after',
		)
		expect(screen.getByTestId('person-consent-dialog')).toBeInTheDocument()
		expect(emailSwitch()).not.toBeChecked()
	})

	it.each([
		['phone_required', 409, 'Add a phone number first'],
		['insufficient_permissions', 403, 'do not have permission'],
		['no_customer', 409, 'customer account'],
	])('maps %s to a plain message', async (code, status, text) => {
		setup([], () => {
			throw new PeopleApiError('x', status, code)
		})
		fireEvent.click(emailSwitch())
		await screen.findByTestId('person-consent-dialog')
		fireEvent.click(screen.getByRole('radio', { name: 'In person' }))
		fireEvent.click(screen.getByRole('checkbox'))
		fireEvent.click(screen.getByTestId('person-consent-confirm'))
		expect(await screen.findByTestId('person-consent-error')).toHaveTextContent(
			text,
		)
	})
})

describe('PersonMarketingCard turning off', () => {
	it('sends one request without a dialog', async () => {
		const request = setup([sub()], (path) =>
			path === '/c_1/consent'
				? {
						subscription: sub({
							subscribed: false,
							unsubscribedAt: 5,
							unsubscribedSource: 'operator',
						}),
					}
				: undefined,
		)
		fireEvent.click(emailSwitch())
		expect(screen.queryByTestId('person-consent-dialog')).toBeNull()
		await waitFor(() =>
			expect(screen.getByTestId('person-consent-email')).toHaveTextContent(
				'Turned off by staff on',
			),
		)
		expect(request).toHaveBeenCalledTimes(1)
		expect(request).toHaveBeenCalledWith('/c_1/consent', {
			method: 'POST',
			body: { channel: 'email', subscribed: false },
		})
		expect(emailSwitch()).not.toBeChecked()
	})

	it('rolls back when the request fails', async () => {
		const request = setup([sub()], () => {
			throw new PeopleApiError('x', 500, null)
		})
		fireEvent.click(emailSwitch())
		await waitFor(() => expect(request).toHaveBeenCalledTimes(1))
		await waitFor(() => expect(emailSwitch()).toBeChecked())
		expect(emailSwitch()).not.toHaveAttribute('aria-disabled', 'true')
	})
})
