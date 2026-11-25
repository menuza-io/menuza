import { describe, expect, it, vi } from 'vitest'
import { createDeliveriesApi, DeliveriesError } from './api.ts'
import { type PosSettings } from '~/lib/config.ts'
import { type Session } from '~/lib/signin.ts'

const settings = {
	tenantApiUrl: 'https://us.node.test/',
	deviceToken: 'pdv1.org.dev.secret',
} as PosSettings
const session = { serverSession: { token: 'staff-token' } } as Session

describe('deliveries regional client (#287)', () => {
	it('calls /pos/deliveries on the region directly with the device and staff credentials, no cookies, no cache', async () => {
		const fetchImpl = vi.fn(async () => Response.json({ role: 'driver', notices: [] }))
		await createDeliveriesApi(settings, session, fetchImpl).me()
		expect(fetchImpl).toHaveBeenCalledWith(
			'https://us.node.test/pos/deliveries/me',
			expect.objectContaining({
				method: 'GET',
				cache: 'no-store',
				credentials: 'omit',
				headers: {
					Authorization: `Bearer ${settings.deviceToken}`,
					'Pos-Staff-Session': 'staff-token',
				},
			}),
		)
	})

	it('sends each action as one request with its body, and never retries', async () => {
		const fetchImpl = vi.fn(async () => Response.json({ ok: true }))
		const api = createDeliveriesApi(settings, session, fetchImpl)
		await api.assign('s1', ['o1', 'o2'])
		await api.claim(['o3'])
		await api.pickUp('run 1')
		await api.delivered('st1', 1500)
		await api.delivered('st2')
		await api.problem('st3', 'not_home')
		await api.myAvailability(true)
		await api.sharePosition(41.9, -87.6)
		await api.stopSharing()
		const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>
		const seen = calls.map(([url, init]) => [
			init.method,
			url.replace('https://us.node.test/pos/deliveries', ''),
			init.body ? JSON.parse(String(init.body)) : null,
		])
		expect(seen).toEqual([
			['POST', '/runs', { driverStaffId: 's1', orderIds: ['o1', 'o2'] }],
			['POST', '/claim', { orderIds: ['o3'] }],
			['POST', '/runs/run%201/pickup', null],
			['POST', '/stops/st1/delivered', { cashCollectedCents: 1500 }],
			['POST', '/stops/st2/delivered', {}],
			['POST', '/stops/st3/problem', { kind: 'not_home' }],
			['POST', '/me/availability', { unavailable: true }],
			['POST', '/run/location', { lat: 41.9, lng: -87.6 }],
			['DELETE', '/run/location', null],
		])
	})

	it('reads the error code, and says connection_lost when there is no answer', async () => {
		const refused = await createDeliveriesApi(settings, session, vi.fn(async () =>
			Response.json({ error: 'order_already_assigned' }, { status: 409 }),
		))
			.assign('s1', ['o1'])
			.catch((error: unknown) => error)
		expect(refused).toBeInstanceOf(DeliveriesError)
		expect(refused).toMatchObject({ code: 'order_already_assigned', status: 409 })
		const lost = await createDeliveriesApi(settings, session, vi.fn(async () => {
			throw new Error('offline')
		}))
			.me()
			.catch((error: unknown) => error)
		expect(lost).toMatchObject({ code: 'connection_lost' })
	})

	it('refuses an unpaired terminal and a terminal with no server without calling anything', async () => {
		const fetchImpl = vi.fn(async () => Response.json({}))
		await expect(
			createDeliveriesApi({ ...settings, deviceToken: null } as PosSettings, session, fetchImpl).me(),
		).rejects.toMatchObject({ code: 'invalid_device' })
		await expect(
			createDeliveriesApi({ ...settings, tenantApiUrl: '' } as PosSettings, session, fetchImpl).me(),
		).rejects.toMatchObject({ code: 'invalid_server' })
		expect(fetchImpl).not.toHaveBeenCalled()
	})
})
