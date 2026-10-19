// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BookingSheet } from '#app/components/reservations/booking-sheet.tsx'
import {
	apiError,
	createScriptedClient,
	type ScriptedCall,
} from '#app/components/reservations/scripted-test-client.ts'
import { ReservationsApiError } from '#app/utils/reservations/reservations-client.ts'
import { renderStaff } from '#tests/staff-render.tsx'

const toasts = vi.hoisted(() => ({ warning: vi.fn() }))
vi.mock('sonner', () => ({ toast: { warning: toasts.warning } }))

type Slot = Record<string, unknown>

function slot(localStartMin: number, extra: Slot = {}): Slot {
	return {
		localStartMin,
		hhmm: `${String(Math.floor(localStartMin / 60)).padStart(2, '0')}:${String(localStartMin % 60).padStart(2, '0')}`,
		serviceId: 'svc-dinner',
		serviceName: 'Dinner',
		available: true,
		pacingWarning: false,
		overbookAvailable: true,
		held: false,
		heldTableIds: [],
		suggestedTableIds: ['t1'],
		...extra,
	}
}

function availability(extra: Record<string, unknown>) {
	return {
		locationId: 'loc-1',
		businessDate: '2026-10-20',
		partySize: 2,
		closed: false,
		onlineClosed: false,
		dayState: { state: 'open', name: null, note: null },
		slots: [],
		...extra,
	}
}

const created = {
	reservation: { id: 'rsv-new', version: 1, guestName: 'Ada' },
	moves: [],
	warnings: [],
}

function renderSheet(
	handler: (call: ScriptedCall) => unknown,
	onCreated = vi.fn(),
) {
	const scripted = createScriptedClient(handler)
	renderStaff(
		<BookingSheet
			open
			onOpenChange={vi.fn()}
			client={scripted.client}
			locationId="loc-1"
			defaultDate="2026-10-20"
			services={[]}
			areas={[]}
			tables={[
				{
					id: 't1',
					label: 'T1',
					areaId: 'a1',
					isActive: true,
					minCovers: 1,
					maxCovers: 4,
				} as never,
			]}
			initialLocalStartMin={1140}
			onCreated={onCreated}
		/>,
	)
	return scripted
}

async function fillGuest() {
	fireEvent.change(screen.getByTestId('booking-guest-name'), {
		target: { value: 'Ada Lovelace' },
	})
	fireEvent.change(screen.getByTestId('booking-guest-phone'), {
		target: { value: '+15555550100' },
	})
}

describe('BookingSheet availability states', () => {
	beforeEach(() => {
		toasts.warning.mockReset()
	})

	it('shows a closed-day warning with no slots and blocks booking until the override is on', async () => {
		const { calls } = renderSheet((call) =>
			call.method === 'GET'
				? availability({
						closed: true,
						dayState: { state: 'closed', name: 'Private event', note: null },
						slots: [],
					})
				: created,
		)
		expect(await screen.findByTestId('booking-closed-day')).toHaveTextContent(
			'Private event',
		)
		expect(screen.queryByTestId('booking-slots-grid')).toBeNull()
		await fillGuest()
		const submit = screen.getByTestId('booking-submit-btn')
		expect(submit).toBeDisabled()
		fireEvent.click(screen.getByTestId('booking-override-closed-day'))
		expect(submit).toBeEnabled()
		fireEvent.click(submit)
		await waitFor(() =>
			expect(calls.some((c) => c.method === 'POST')).toBe(true),
		)
		const post = calls.find((c) => c.method === 'POST')!
		expect(post.body).toMatchObject({
			overbook: true,
			overbookReason: 'Operator closed-day override',
		})
	})

	it('flags online_closed days but keeps slots bookable without an override', async () => {
		const { calls } = renderSheet((call) =>
			call.method === 'GET'
				? availability({
						onlineClosed: true,
						dayState: { state: 'online_closed', name: null, note: null },
						slots: [slot(1140)],
					})
				: created,
		)
		expect(await screen.findByTestId('booking-online-closed')).toBeVisible()
		expect(screen.queryByTestId('booking-closed-day')).toBeNull()
		expect(screen.queryByTestId('booking-override-closed-day')).toBeNull()
		expect(await screen.findByTestId('booking-slot-1140')).toBeVisible()
		await fillGuest()
		fireEvent.click(screen.getByTestId('booking-submit-btn'))
		await waitFor(() =>
			expect(calls.some((c) => c.method === 'POST')).toBe(true),
		)
		expect(calls.find((c) => c.method === 'POST')!.body).not.toHaveProperty(
			'overbook',
		)
	})

	it('shows the pacing warning when an over-paced slot is picked and sends the overbook flag', async () => {
		const onCreated = vi.fn()
		const { calls } = renderSheet(
			(call) =>
				call.method === 'GET'
					? availability({
							slots: [
								slot(1140),
								slot(1155, { available: false, pacingWarning: true }),
							],
						})
					: {
							...created,
							warnings: [
								{ code: 'pacing_parties_exceeded', message: 'server text' },
							],
						},
			onCreated,
		)
		fireEvent.click(await screen.findByTestId('booking-slot-1155'))
		expect(screen.getByTestId('booking-pacing-warning')).toBeVisible()
		await fillGuest()
		fireEvent.click(screen.getByTestId('booking-submit-btn'))
		await waitFor(() => expect(onCreated).toHaveBeenCalled())
		expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({
			overbook: true,
		})
		expect(toasts.warning).toHaveBeenCalledWith(
			'Booked over the pacing party limit.',
		)
	})

	it('shows held slots as held and warns that booking overrides the hold', async () => {
		const { calls } = renderSheet((call) =>
			call.method === 'GET'
				? availability({
						slots: [
							slot(1140),
							slot(1200, {
								available: false,
								held: true,
								heldTableIds: ['t1'],
								suggestedTableIds: [],
							}),
						],
					})
				: created,
		)
		const chip = await screen.findByTestId('booking-slot-1200')
		expect(chip).toHaveAttribute('data-held', 'true')
		expect(screen.getByTestId('booking-slot-held-1200')).toHaveTextContent(
			'Held',
		)
		expect(screen.getByTestId('booking-slot-1140')).not.toHaveAttribute(
			'data-held',
		)
		fireEvent.click(chip)
		expect(screen.getByTestId('booking-held-warning')).toHaveTextContent('T1')
		await fillGuest()
		fireEvent.click(screen.getByTestId('booking-submit-btn'))
		await waitFor(() =>
			expect(calls.some((c) => c.method === 'POST')).toBe(true),
		)
		expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({
			overbook: true,
		})
	})

	it('explains a closed_day refusal from tenant-api in plain words', async () => {
		renderSheet((call) => {
			if (call.method === 'GET') return availability({ slots: [slot(1140)] })
			return new ReservationsApiError('server text', 409, {
				error: 'closed_day',
			})
		})
		await screen.findByTestId('booking-slot-1140')
		await fillGuest()
		fireEvent.click(screen.getByTestId('booking-submit-btn'))
		expect(await screen.findByTestId('booking-sheet-error')).toHaveTextContent(
			'closed-day override',
		)
	})

	it('keeps a partly held slot bookable without an override', async () => {
		const { calls } = renderSheet((call) =>
			call.method === 'GET'
				? availability({
						slots: [
							slot(1200, {
								held: true,
								heldTableIds: ['t1'],
								suggestedTableIds: ['t2'],
							}),
						],
					})
				: created,
		)
		fireEvent.click(await screen.findByTestId('booking-slot-1200'))
		expect(screen.getByTestId('booking-held-warning')).toHaveTextContent(
			'another table',
		)
		await fillGuest()
		fireEvent.click(screen.getByTestId('booking-submit-btn'))
		await waitFor(() =>
			expect(calls.some((c) => c.method === 'POST')).toBe(true),
		)
		expect(calls.find((c) => c.method === 'POST')!.body).not.toHaveProperty(
			'overbook',
		)
	})
})

describe('BookingSheet flow', () => {
	beforeEach(() => {
		toasts.warning.mockReset()
	})

	it('shows a format hint instead of "missing" when the phone number is filled but invalid', async () => {
		renderSheet((call) =>
			call.method === 'GET' ? availability({ slots: [slot(1140)] }) : created,
		)
		await screen.findByTestId('booking-slot-1140')
		fireEvent.change(screen.getByTestId('booking-guest-phone'), {
			target: { value: 'abc' },
		})
		fireEvent.change(screen.getByTestId('booking-guest-name'), {
			target: { value: 'QA Tester' },
		})
		expect(screen.getByText(/Enter a valid phone number, e\.g\./)).toBeTruthy()
		expect(screen.getByTestId('booking-validation-summary')).toHaveTextContent(
			'valid phone number',
		)
		expect(screen.getByTestId('booking-submit-btn')).toBeDisabled()
	})

	it('lists what is still needed from the start and keeps Book off until it is filled', async () => {
		const { calls } = renderSheet((call) =>
			call.method === 'GET' ? availability({ slots: [slot(1140)] }) : created,
		)
		await screen.findByTestId('booking-slot-1140')
		expect(screen.getByTestId('booking-validation-summary')).toHaveTextContent(
			'phone number',
		)
		const submit = screen.getByTestId('booking-submit-btn')
		expect(submit).toBeDisabled()
		await fillGuest()
		expect(screen.queryByTestId('booking-validation-summary')).toBeNull()
		expect(submit).toBeEnabled()
		expect(calls.some((c) => c.method === 'POST')).toBe(false)
	})

	it('focuses the phone field when the sheet opens', async () => {
		renderSheet(() => availability({ slots: [slot(1140)] }))
		await waitFor(() =>
			expect(screen.getByTestId('booking-guest-phone')).toHaveFocus(),
		)
	})

	it('hides Other time behind a link while time chips exist', async () => {
		renderSheet(() => availability({ slots: [slot(1140)] }))
		await screen.findByTestId('booking-slot-1140')
		expect(screen.queryByTestId('booking-time-input')).toBeNull()
		fireEvent.click(screen.getByTestId('booking-other-time-link'))
		expect(screen.getByTestId('booking-time-input')).toBeVisible()
	})

	it('shows the time field straight away when no times are offered', async () => {
		renderSheet(() => availability({ slots: [] }))
		expect(await screen.findByTestId('booking-time-input')).toBeVisible()
	})

	it('writes dietary chips into the stored dietary text, in front of the typed notes', async () => {
		const { calls } = renderSheet((call) =>
			call.method === 'GET' ? availability({ slots: [slot(1140)] }) : created,
		)
		await screen.findByTestId('booking-slot-1140')
		await fillGuest()
		fireEvent.click(screen.getByTestId('booking-extras-toggle'))
		fireEvent.click(await screen.findByTestId('booking-dietary-nut_allergy'))
		fireEvent.click(screen.getByTestId('booking-dietary-vegan'))
		fireEvent.change(screen.getByTestId('booking-dietary-notes'), {
			target: { value: 'No sesame' },
		})
		fireEvent.click(screen.getByTestId('booking-submit-btn'))
		await waitFor(() =>
			expect(calls.some((c) => c.method === 'POST')).toBe(true),
		)
		expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({
			dietaryNotes: 'nut_allergy, vegan, No sesame',
		})
	})

	it('keeps the newest availability when an older request answers last', async () => {
		const resolvers: Array<(value: unknown) => void> = []
		const scripted = createScriptedClient((call) => {
			if (call.method !== 'GET') return created
			return new Promise((resolve) => {
				resolvers.push(resolve)
			})
		})
		renderStaff(
			<BookingSheet
				open
				onOpenChange={vi.fn()}
				client={scripted.client}
				locationId="loc-1"
				defaultDate="2026-10-20"
				services={[]}
				areas={[]}
				tables={[]}
				initialLocalStartMin={1140}
				onCreated={vi.fn()}
			/>,
		)
		await waitFor(() => expect(resolvers).toHaveLength(1))
		fireEvent.click(screen.getByRole('button', { name: 'More guests' }))
		await waitFor(() => expect(resolvers).toHaveLength(2))
		// eslint-disable-next-line testing-library/no-unnecessary-act
		await act(async () => {
			resolvers[1]!(availability({ slots: [slot(1200)] }))
		})
		// eslint-disable-next-line testing-library/no-unnecessary-act
		await act(async () => {
			resolvers[0]!(availability({ slots: [slot(1140)] }))
		})
		expect(screen.getByTestId('booking-slot-1200')).toBeVisible()
		expect(screen.queryByTestId('booking-slot-1140')).toBeNull()
	})
})

describe('BookingSheet idempotency key', () => {
	const postKeys = (calls: ScriptedCall[]) =>
		calls
			.filter((c) => c.method === 'POST')
			.map((c) => c.headers?.['Idempotency-Key'])

	async function submitAndSettle(calls: ScriptedCall[], count: number) {
		fireEvent.click(screen.getByTestId('booking-submit-btn'))
		await waitFor(() => expect(postKeys(calls)).toHaveLength(count))
		await waitFor(() =>
			expect(screen.getByTestId('booking-submit-btn')).not.toHaveTextContent(
				'Booking...',
			),
		)
	}

	function outcomes(...replies: Array<'network' | 'ok' | number>) {
		let post = 0
		return (call: ScriptedCall) => {
			if (call.method === 'GET') return availability({ slots: [slot(1140)] })
			const reply = replies[post++] ?? 'ok'
			if (reply === 'ok') return created
			if (reply === 'network') throw new TypeError('Failed to fetch')
			return apiError(reply, reply >= 500 ? 'server_error' : 'rejected')
		}
	}

	beforeEach(() => {
		toasts.warning.mockReset()
	})

	it('keeps the key across a network error and a 5xx, so a lost response replays', async () => {
		const { calls } = renderSheet(outcomes('network', 503, 'ok'))
		await fillGuest()
		await submitAndSettle(calls, 1)
		await submitAndSettle(calls, 2)
		await submitAndSettle(calls, 3)
		const keys = postKeys(calls)
		expect(keys[0]).toBeTruthy()
		expect(new Set(keys).size).toBe(1)
	})

	it('takes a new key after a definite 4xx rejection', async () => {
		const { calls } = renderSheet(outcomes(409, 'ok'))
		await fillGuest()
		await submitAndSettle(calls, 1)
		await submitAndSettle(calls, 2)
		const [first, second] = postKeys(calls)
		expect(second).not.toBe(first)
	})

	it('takes a new key when the form changed since the failed attempt', async () => {
		const { calls } = renderSheet(outcomes('network', 'ok'))
		await fillGuest()
		await submitAndSettle(calls, 1)
		fireEvent.change(screen.getByTestId('booking-guest-name'), {
			target: { value: 'Grace Hopper' },
		})
		await submitAndSettle(calls, 2)
		const [first, second] = postKeys(calls)
		expect(second).not.toBe(first)
	})
})
