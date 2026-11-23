import {
	createRegionClient,
	type InventoryAccess,
	RegionError,
	TOKEN_EARLY_REFRESH_MS,
} from '../region-client'

function access(overrides: Partial<InventoryAccess> = {}): InventoryAccess {
	return {
		jwt: 'jwt-1',
		tenantApiUrl: 'https://us.tenant.example/',
		scope: 'read',
		grants: ['read:inventory:any'],
		features: {
			enabled: true,
			purchasing: true,
			recipes: false,
			prep: false,
			transfers: false,
		},
		expiresAt: 10 * 60_000,
		organizationId: 'org_12345678',
		currency: 'USD',
		canManageSettings: false,
		locations: [{ id: 'loc_a', name: 'Downtown' }],
		...overrides,
	}
}

function reply(status: number, body: unknown): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		text: async () => (body === null ? '' : JSON.stringify(body)),
	} as Response
}

describe('the phone region client (#516)', () => {
	it('calls the regional node directly with the short-lived token, never the App', async () => {
		const fetchAccess = jest.fn(async () => access())
		const fetchImpl = jest.fn(async () => reply(200, { ok: true }))
		const client = createRegionClient({
			organizationId: 'org_12345678',
			fetchAccess,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			now: () => 0,
		})
		await client.request('/counts?locationId=loc_a')
		expect(fetchImpl).toHaveBeenCalledWith(
			'https://us.tenant.example/operator/inventory/counts?locationId=loc_a',
			expect.objectContaining({
				method: 'GET',
				headers: expect.objectContaining({ Authorization: 'Bearer jwt-1' }),
			}),
		)
	})

	it('reuses a token until just before it expires, then takes a new one', async () => {
		let now = 0
		const fetchAccess = jest.fn(async () =>
			access({ jwt: `jwt-${now}`, expiresAt: now + 10 * 60_000 }),
		)
		const fetchImpl = jest.fn(async () => reply(200, {}))
		const client = createRegionClient({
			organizationId: 'org_12345678',
			fetchAccess,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			now: () => now,
		})
		await client.request('/a')
		now = 5 * 60_000
		await client.request('/b')
		expect(fetchAccess).toHaveBeenCalledTimes(1)
		now = 10 * 60_000 - TOKEN_EARLY_REFRESH_MS + 1
		await client.request('/c')
		expect(fetchAccess).toHaveBeenCalledTimes(2)
	})

	it('keeps read and write tokens apart and asks once for a burst of calls', async () => {
		const fetchAccess = jest.fn(async (_org: string, scope: 'read' | 'write') =>
			access({ jwt: `jwt-${scope}`, scope }),
		)
		const fetchImpl = jest.fn(async () => reply(200, {}))
		const client = createRegionClient({
			organizationId: 'org_12345678',
			fetchAccess,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			now: () => 0,
		})
		await Promise.all([
			client.request('/a'),
			client.request('/b'),
			client.request('/c', { method: 'POST', write: true, body: { x: 1 } }),
		])
		expect(fetchAccess).toHaveBeenCalledTimes(2)
		const calls = fetchImpl.mock.calls as unknown as Array<
			[string, { headers: Record<string, string> }]
		>
		expect(calls.map((call) => call[1].headers.Authorization).sort()).toEqual([
			'Bearer jwt-read',
			'Bearer jwt-read',
			'Bearer jwt-write',
		])
	})

	it('takes a new token once after a 401 and retries', async () => {
		let issued = 0
		const fetchAccess = jest.fn(async () => access({ jwt: `jwt-${++issued}` }))
		const fetchImpl = jest
			.fn()
			.mockResolvedValueOnce(reply(401, { code: 'unauthorized' }))
			.mockResolvedValueOnce(reply(200, { ok: true }))
		const client = createRegionClient({
			organizationId: 'org_12345678',
			fetchAccess,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			now: () => 0,
		})
		await expect(client.request('/a')).resolves.toEqual({ ok: true })
		expect(fetchAccess).toHaveBeenCalledTimes(2)
	})

	it('turns refusals and a dead network into typed errors', async () => {
		const refuse = createRegionClient({
			organizationId: 'org_12345678',
			fetchAccess: async () => access(),
			fetchImpl: (async () =>
				reply(409, {
					code: 'devices_still_counting',
					devices: [{ deviceId: 'd1' }],
				})) as unknown as typeof fetch,
			now: () => 0,
		})
		await expect(refuse.request('/counts/c1/approve')).rejects.toMatchObject({
			status: 409,
			code: 'devices_still_counting',
			body: { devices: [{ deviceId: 'd1' }] },
		})
		const offline = createRegionClient({
			organizationId: 'org_12345678',
			fetchAccess: async () => access(),
			fetchImpl: (async () => {
				throw new TypeError('Network request failed')
			}) as unknown as typeof fetch,
			now: () => 0,
		})
		const error = await offline.request('/a').catch((caught) => caught)
		expect(error).toBeInstanceOf(RegionError)
		expect(error).toMatchObject({ status: 0, code: 'network_error' })
	})
})
