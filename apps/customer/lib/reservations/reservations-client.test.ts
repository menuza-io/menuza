import { describe, expect, it } from '@jest/globals'
import { type BookingFailure, mapBookingFailure } from './booking-flow'
import { makeGuestDetails, ReservationApiError } from './models'
import { ReservationsClient } from './reservations-client'
import { ApiError } from '@/lib/api/api-error'
import { TenantApiClient } from '@/lib/api/tenant-api-client'
import { CustomerSession } from '@/lib/session/customer-session'
import { createMemoryTokenStorage } from '@/lib/session/token-storage'
import { type FixtureName, fixtureText } from '@/test/reservations/fixtures'
import { makeReservationsClient } from '@/test/reservations/session'
import { failingTransport, header, StubTransport } from '@/test/stub-transport'
import { makeAccessToken, makeConfiguration } from '@/test/support'

function fixtureTransport(...names: FixtureName[]): StubTransport {
	return new StubTransport(
		names.map((name) => ({ status: 200, raw: fixtureText(name) })),
	)
}

const details = makeGuestDetails({
	firstName: ' Ada ',
	lastName: 'Lovelace',
	phone: '+14155553001',
	email: 'ada@example.com',
	occasionTagId: 'tag_pub_birthday',
	requests: 'Window seat',
	dietary: '',
	smsOptIn: true,
	locale: 'en',
	policyTermsVersion: '2',
})

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise
	} catch (error) {
		return error
	}
	throw new Error('expected the call to fail')
}

describe('ReservationsClient request shape', () => {
	it('sends the binding, the client header and the bearer without Turnstile', async () => {
		const transport = fixtureTransport('availability')
		const client = await makeReservationsClient(transport.send)

		const availability = await client.availability({
			locationId: 'loc_pub_main',
			date: '2030-06-24',
			partySize: 2,
			localMin: 1140,
		})

		expect(availability.status).toBe('available')
		const recorded = transport.lastRequest!
		expect(recorded.request.method).toBe('GET')
		expect(recorded.url.pathname).toBe('/reservations/availability')
		const query = recorded.url.search
		expect(query).toContain('slug=acme')
		expect(query).toContain('locationId=loc_pub_main')
		expect(query).toContain('date=2030-06-24')
		expect(query).toContain('partySize=2')
		expect(query).toContain('localMin=1140')
		// The binding first, then the parameters by name.
		expect([...recorded.url.searchParams.keys()]).toEqual([
			'slug',
			'date',
			'localMin',
			'locationId',
			'partySize',
		])
		expect(header(recorded, 'X-Client')).toBe('ios')
		expect(header(recorded, 'Authorization')?.startsWith('Bearer ')).toBe(true)
		expect(header(recorded, 'Accept')).toBe('application/json')
		expect(header(recorded, 'X-Turnstile-Token')).toBeUndefined()
		expect(recorded.url.host).toBe('tenant-us.epic-startup.com')
	})

	it('sends X-Client android from an Android build', async () => {
		const transport = fixtureTransport('config')
		const client = await makeReservationsClient(transport.send, {
			platform: 'android',
		})
		await client.config()
		expect(header(transport.lastRequest, 'X-Client')).toBe('android')
	})

	it('sends the site origin for https sites', async () => {
		const transport = fixtureTransport('config')
		const client = await makeReservationsClient(transport.send, {
			configuration: makeConfiguration({
				origin: 'https://acme.epic-startup.com',
			}),
		})

		await client.config()

		expect(header(transport.lastRequest, 'Origin')).toBe(
			'https://acme.epic-startup.com',
		)
	})

	it('sends no origin for local sites and relies on the slug binding', async () => {
		const transport = fixtureTransport('config')
		const client = await makeReservationsClient(transport.send, {
			configuration: makeConfiguration({
				origin: 'http://acme.localhost:3008',
			}),
		})

		await client.config()

		expect(header(transport.lastRequest, 'Origin')).toBeUndefined()
		expect(transport.lastRequest?.url.search).toContain('slug=acme')
	})

	it('prefers the host binding and skips empty parameters', async () => {
		const transport = fixtureTransport('config')
		const client = await makeReservationsClient(transport.send, {
			configuration: makeConfiguration({ host: 'www.acme.com' }),
		})

		await client.config('')

		expect(transport.lastRequest?.url.search).toBe('?host=www.acme.com')
	})

	it('calls the KSA node for KSA organizations', async () => {
		const transport = fixtureTransport('config')
		const client = await makeReservationsClient(transport.send, {
			configuration: makeConfiguration({ region: 'ksa' }),
		})

		await client.config()

		expect(transport.lastRequest?.url.host).toBe('tenant-ksa.epic-startup.com')
	})

	it('posts a hold with the slot and no phone or Turnstile field', async () => {
		const transport = fixtureTransport('hold')
		const client = await makeReservationsClient(transport.send)

		const hold = await client.createHold({
			locationId: 'loc_pub_main',
			date: '2030-06-24',
			localMin: 1140,
			partySize: 2,
			serviceId: 'svc_pub_dinner',
		})

		expect(hold.holdToken).not.toBe('')
		const recorded = transport.lastRequest!
		expect(recorded.request.method).toBe('POST')
		expect(recorded.url.pathname).toBe('/reservations/holds')
		expect(header(recorded, 'Content-Type')).toBe('application/json')
		expect(recorded.body).toEqual({
			locationId: 'loc_pub_main',
			slot: {
				date: '2030-06-24',
				localMin: 1140,
				partySize: 2,
				serviceId: 'svc_pub_dinner',
			},
		})
	})

	it('sends the area preference and the hold it replaces', async () => {
		const transport = fixtureTransport('hold')
		const client = await makeReservationsClient(transport.send)

		await client.createHold({
			locationId: 'loc_pub_main',
			date: '2030-06-24',
			localMin: 1140,
			partySize: 2,
			areaId: 'area_main',
			replaceHoldToken: 'hold_token_old_0001',
		})

		expect(transport.lastRequest?.body).toEqual({
			locationId: 'loc_pub_main',
			slot: { date: '2030-06-24', localMin: 1140, partySize: 2 },
			areaPref: 'area_main',
			replaceHoldToken: 'hold_token_old_0001',
		})
	})

	it('books with the idempotency key, the guest block and an empty honeypot', async () => {
		const transport = fixtureTransport('booking')
		const client = await makeReservationsClient(transport.send)

		const booking = await client.book({
			holdToken: 'hold_secret_token_value',
			details,
			idempotencyKey: 'native-key-0001',
		})

		expect(booking.reservation.status).toBe('booked')
		const recorded = transport.lastRequest!
		expect(recorded.request.method).toBe('POST')
		expect(recorded.url.pathname).toBe('/reservations')
		expect(header(recorded, 'Idempotency-Key')).toBe('native-key-0001')
		expect(recorded.body.holdToken).toBe('hold_secret_token_value')
		expect(recorded.body.website).toBe('')
		expect(recorded.body.smsOptIn).toBe(true)
		expect(recorded.body.turnstileToken).toBeUndefined()
		expect(recorded.body.guest).toEqual({
			firstName: 'Ada',
			lastName: 'Lovelace',
			phone: '+14155553001',
			email: 'ada@example.com',
		})
		expect(recorded.body.occasionTagId).toBe('tag_pub_birthday')
		expect(recorded.body.requests).toBe('Window seat')
		// Empty optional text is omitted.
		expect('dietary' in recorded.body).toBe(false)
		expect(recorded.body.policyAccepted).toEqual({ termsVersion: '2' })
		// The hold token travels in the body, never in the URL.
		expect(recorded.url.href).not.toContain('hold_secret_token_value')
	})

	it('sends the same idempotency key on a retry after a network error', async () => {
		const offline = await makeReservationsClient(failingTransport)
		const error = await failureOf(
			offline.book({
				holdToken: 'hold_token_abcdef',
				details,
				idempotencyKey: 'key-retry-001',
			}),
		)
		expect(error).toBeInstanceOf(ApiError)
		expect((error as ApiError).isTransportFailure).toBe(true)

		const transport = fixtureTransport('booking')
		const client = await makeReservationsClient(transport.send)
		await client.book({
			holdToken: 'hold_token_abcdef',
			details,
			idempotencyKey: 'key-retry-001',
		})
		expect(header(transport.lastRequest, 'Idempotency-Key')).toBe(
			'key-retry-001',
		)
	})

	it('posts a large-party request with the slot inside the body', async () => {
		const transport = fixtureTransport('request')
		const client = await makeReservationsClient(transport.send)

		const booking = await client.requestLargeParty({
			locationId: 'loc_pub_main',
			date: '2030-06-24',
			localMin: 1020,
			partySize: 8,
			details,
			idempotencyKey: 'native-key-0002',
		})

		expect(booking.reservation.status).toBe('requested')
		const recorded = transport.lastRequest!
		expect(recorded.url.pathname).toBe('/reservations/requests')
		expect(header(recorded, 'Idempotency-Key')).toBe('native-key-0002')
		expect(recorded.body.locationId).toBe('loc_pub_main')
		expect(recorded.body.slot).toEqual({
			date: '2030-06-24',
			localMin: 1020,
			partySize: 8,
		})
	})

	it('sends the manage token in the header, never the URL', async () => {
		const transport = fixtureTransport('manage')
		const client = await makeReservationsClient(transport.send)

		await client.manage('rsv_m_secret_manage_token')

		const recorded = transport.lastRequest!
		expect(recorded.request.method).toBe('GET')
		expect(recorded.url.pathname).toBe('/reservations/manage')
		expect(header(recorded, 'X-Reservation-Token')).toBe(
			'rsv_m_secret_manage_token',
		)
		expect(recorded.url.href).not.toContain('rsv_m_secret_manage_token')
	})

	it('polls the payment status with a GET and the token header', async () => {
		const transport = fixtureTransport('payment-status-pending')
		const client = await makeReservationsClient(transport.send)

		const status = await client.paymentStatus('rsv_p_secret_payment_token')

		expect(status.paymentStatus).toBe('pending')
		const recorded = transport.lastRequest!
		expect(recorded.request.method).toBe('GET')
		expect(recorded.url.pathname).toBe('/reservations/manage/payment')
		expect(header(recorded, 'X-Reservation-Token')).toBe(
			'rsv_p_secret_payment_token',
		)
		expect(recorded.request.body).toBeUndefined()
	})

	it('posts manage mutations with an empty or small body', async () => {
		const transport = fixtureTransport('manage', 'manage', 'manage', 'manage')
		const client = await makeReservationsClient(transport.send)

		await client.modify('tok_manage_0001', {
			date: '2030-06-25',
			localMin: 1170,
			partySize: 3,
		})
		await client.cancel('tok_manage_0001')
		await client.confirm('tok_manage_0001')
		await client.runningLate('tok_manage_0001', 15)

		expect(transport.paths).toEqual([
			'/reservations/manage/modify',
			'/reservations/manage/cancel',
			'/reservations/manage/confirm',
			'/reservations/manage/running-late',
		])
		expect(
			transport.recorded.every((entry) => entry.request.method === 'POST'),
		).toBe(true)
		expect(transport.recorded[0]?.body).toEqual({
			localMin: 1170,
			date: '2030-06-25',
			partySize: 3,
		})
		expect(transport.recorded[1]?.body).toEqual({})
		expect(transport.recorded[3]?.body).toEqual({ minutes: 15 })
	})

	it('modifies only the fields that change', async () => {
		const transport = fixtureTransport('manage')
		const client = await makeReservationsClient(transport.send)
		await client.modify('tok_manage_0001', { localMin: 1140 })
		expect(transport.lastRequest?.body).toEqual({ localMin: 1140 })
	})

	it('makes every call a GET or POST with the client header, bearer and binding', async () => {
		const transport = new StubTransport(() => ({ status: 200, json: {} }))
		const client = await makeReservationsClient(transport.send)
		const key = 'native-key-9999'
		const calls: Array<() => Promise<unknown>> = [
			() => client.config('ar'),
			() =>
				client.availability({
					locationId: 'l',
					date: '2030-06-24',
					partySize: 2,
				}),
			() =>
				client.calendar({
					locationId: 'l',
					partySize: 2,
					from: '2030-06-24',
					to: '2030-06-30',
				}),
			() =>
				client.createHold({
					locationId: 'l',
					date: '2030-06-24',
					localMin: 1140,
					partySize: 2,
				}),
			() => client.releaseHold('hold_token_0001'),
			() =>
				client.book({
					holdToken: 'hold_token_0001',
					details,
					idempotencyKey: key,
				}),
			() =>
				client.requestLargeParty({
					locationId: 'l',
					date: '2030-06-24',
					localMin: 1140,
					partySize: 9,
					details,
					idempotencyKey: key,
				}),
			() => client.mine(),
			() => client.manage('tok_manage_0001'),
			() =>
				client.manageAvailability('tok_manage_0001', { date: '2030-06-25' }),
			() => client.modify('tok_manage_0001', { localMin: 1140 }),
			() => client.cancel('tok_manage_0001'),
			() => client.confirm('tok_manage_0001'),
			() => client.runningLate('tok_manage_0001', 10),
			() => client.paymentStatus('tok_pay_0001'),
			() =>
				client.joinWaitlist({
					locationId: 'l',
					name: 'Ada',
					partySize: 2,
					phone: '+14155553001',
					smsOptIn: false,
					locale: 'en',
					idempotencyKey: key,
				}),
			() => client.waitlistStatus('tok_wait_0001'),
			() => client.leaveWaitlist('tok_wait_0001'),
			() => client.waitlistOnMyWay('tok_wait_0001'),
		]
		for (const call of calls) {
			try {
				await call()
			} catch {
				// `{}` does not decode for most calls; only the request matters here.
			}
		}

		expect(transport.recorded).toHaveLength(19)
		for (const recorded of transport.recorded) {
			const path = recorded.url.pathname
			expect([path, ['GET', 'POST'].includes(recorded.request.method)]).toEqual(
				[path, true],
			)
			expect([path, header(recorded, 'X-Client')]).toEqual([path, 'ios'])
			expect([
				path,
				header(recorded, 'Authorization')?.startsWith('Bearer '),
			]).toEqual([path, true])
			expect([path, recorded.url.search.includes('slug=acme')]).toEqual([
				path,
				true,
			])
			expect(header(recorded, 'X-Turnstile-Token')).toBeUndefined()
			for (const secret of [
				'tok_manage_0001',
				'tok_pay_0001',
				'tok_wait_0001',
				'hold_token_0001',
			]) {
				expect([path, recorded.url.href.includes(secret)]).toEqual([
					path,
					false,
				])
			}
		}
		// Mutations are POST, reads are GET.
		const mutating = [
			'holds',
			'release',
			'requests',
			'modify',
			'cancel',
			'confirm',
			'running-late',
			'join',
			'leave',
			'on-my-way',
		]
		for (const recorded of transport.recorded) {
			const path = recorded.url.pathname
			if (mutating.some((suffix) => path.endsWith(suffix))) {
				expect([path, recorded.request.method]).toEqual([path, 'POST'])
			}
		}
		expect(
			transport.recorded.filter((entry) => entry.request.method === 'GET'),
		).toHaveLength(8)
		const idempotent = transport.recorded.filter((entry) =>
			header(entry, 'Idempotency-Key'),
		)
		expect(idempotent.map((entry) => entry.url.pathname)).toEqual([
			'/reservations',
			'/reservations/requests',
			'/reservations/waitlist/join',
		])
	})
})

describe('ReservationsClient errors and refresh', () => {
	it('keeps the alternatives of a slot_unavailable answer', async () => {
		const transport = new StubTransport([
			{ status: 409, raw: fixtureText('error-slot-unavailable') },
		])
		const client = await makeReservationsClient(transport.send)

		const error = await failureOf(
			client.createHold({
				locationId: 'l',
				date: '2030-06-24',
				localMin: 1080,
				partySize: 4,
			}),
		)

		expect(error).toBeInstanceOf(ReservationApiError)
		const reservationError = error as ReservationApiError
		expect(reservationError.status).toBe(409)
		expect(reservationError.code).toBe('slot_unavailable')
		expect(reservationError.alternatives?.sameDay.length).toBeGreaterThan(0)
		expect(mapBookingFailure(error)).toEqual({
			kind: 'slotUnavailable',
			alternatives: reservationError.alternatives,
		})
	})

	it('maps hold_expired, rate_limited and policy_required to stable failures', async () => {
		const transport = new StubTransport([
			{ status: 410, raw: fixtureText('error-hold-expired') },
			{ status: 429, raw: fixtureText('error-rate-limited') },
			{ status: 400, raw: fixtureText('error-policy-required') },
		])
		const client = await makeReservationsClient(transport.send)
		const failures: BookingFailure[] = []
		for (let attempt = 0; attempt < 3; attempt += 1) {
			failures.push(
				mapBookingFailure(
					await failureOf(
						client.book({
							holdToken: 'hold_token_0001',
							details,
							idempotencyKey: 'native-key-0003',
						}),
					),
				),
			)
		}
		expect(failures).toEqual([
			{ kind: 'holdExpired' },
			{ kind: 'rateLimited', reason: 'phone_active_limit' },
			{ kind: 'policyRequired' },
		])
	})

	it('refreshes an expired access token once and retries the call', async () => {
		const refreshed = makeAccessToken({
			name: 'Ada Lovelace',
			customerId: 'cust_2',
		})
		const transport = new StubTransport([
			{ status: 401, raw: '{"error":"unauthorized"}' },
			{
				status: 200,
				json: { accessToken: refreshed, refreshToken: 'refresh-2' },
			},
			{ status: 200, raw: fixtureText('config') },
		])
		const client = await makeReservationsClient(transport.send)

		const config = await client.config()

		expect(config.organization.name).toBe('Acme Bistro')
		expect(transport.paths).toEqual([
			'/reservations/config',
			'/auth/refresh',
			'/reservations/config',
		])
		expect(header(transport.recorded[2], 'Authorization')).toBe(
			`Bearer ${refreshed}`,
		)
	})

	it('surfaces offline as a transport failure', async () => {
		const client = await makeReservationsClient(failingTransport)
		expect(mapBookingFailure(await failureOf(client.config()))).toEqual({
			kind: 'offline',
		})
	})

	it('reads an undecodable answer as an API error', async () => {
		const transport = new StubTransport([{ status: 200, raw: 'not json' }])
		const client = await makeReservationsClient(transport.send)
		const error = await failureOf(client.config())
		expect(error).toBeInstanceOf(ApiError)
		expect(error).not.toBeInstanceOf(ReservationApiError)
		expect((error as ApiError).status).toBe(200)
		expect(mapBookingFailure(error)).toEqual({ kind: 'generic' })
	})

	it('fails signed-out calls locally without hitting the network', async () => {
		const transport = new StubTransport()
		const session = new CustomerSession(
			new TenantApiClient(makeConfiguration(), transport.send),
			createMemoryTokenStorage(),
		)
		const client = new ReservationsClient(session, { platform: 'ios' })

		expect(mapBookingFailure(await failureOf(client.config()))).toEqual({
			kind: 'signInRequired',
		})
		expect(transport.recorded).toHaveLength(0)
	})
})
