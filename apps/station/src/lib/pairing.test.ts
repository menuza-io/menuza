import { afterEach, describe, expect, it, vi } from 'vitest'
import { clockIsOff, clockSkewMs, useClock } from './clock.ts'
import { type PosSettings } from './config.ts'
import {
	pairTerminal,
	pairingHosts,
	parseAllowedOrigins,
	parsePairingInput,
	serverOriginProblem,
	serversProblem,
	withPairing,
	type OriginPolicy,
} from './pairing.ts'

const CODE = `ppc1.org_1.${'a'.repeat(43)}`
const link = (params: Record<string, string>) =>
	`https://pos.example.com/#${new URLSearchParams(params)}`

describe('parsePairingInput', () => {
	it('accepts a bare code, with surrounding space', () => {
		expect(parsePairingInput(`  ${CODE}\n`)).toEqual({ code: CODE })
	})

	it('reads everything a full link carries', () => {
		expect(
			parsePairingInput(
				link({
					a: 'https://api.example.com/',
					u: 'https://app.example.com',
					s: 'Joes-Diner',
					c: CODE,
				}),
			),
		).toEqual({
			code: CODE,
			tenantApiUrl: 'https://api.example.com',
			appUrl: 'https://app.example.com',
			slug: 'joes-diner',
		})
	})

	it('accepts just the fragment, as the app passes it after the address bar is cleared', () => {
		expect(
			parsePairingInput(`#a=https%3A%2F%2Fapi.example.com&c=${CODE}`)
				?.tenantApiUrl,
		).toBe('https://api.example.com')
	})

	it('refuses a link whose server address is not an http(s) origin, rather than half-reading it', () => {
		expect(
			parsePairingInput(
				link({
					a: 'javascript:alert(1)',
					u: 'https://app.example.com',
					s: 'x',
					c: CODE,
				}),
			),
		).toBeNull()
		expect(
			parsePairingInput(link({ u: 'file:///etc/passwd', c: CODE })),
		).toBeNull()
		expect(parsePairingInput(link({ a: 'not a url', c: CODE }))).toBeNull()
	})

	it('names the hosts a link points at, for the person confirming it', () => {
		const parsed = parsePairingInput(
			link({
				a: 'https://api.example.com',
				u: 'https://app.example.com',
				c: CODE,
			}),
		)!
		expect(pairingHosts(parsed)).toEqual({
			api: 'api.example.com',
			app: 'app.example.com',
		})
		expect(pairingHosts({ code: CODE })).toEqual({ api: null, app: null })
	})

	it('rejects anything that is not a well-formed code', () => {
		for (const bad of [
			'',
			'hello',
			'ppc1.org.short',
			`kpc1.org_1.${'a'.repeat(43)}`,
			link({ c: 'nope' }),
			link({ a: 'https://x.com' }),
		]) {
			expect(parsePairingInput(bad)).toBeNull()
		}
	})
})

describe('withPairing', () => {
	const base: PosSettings = {
		appUrl: 'https://app.example.com',
		slug: 'demo',
		tenantApiUrl: 'https://api.example.com',
		terminalCode: 'T1',
		locationId: null,
		locationLocked: false,
		scopeId: 'main',
		signInRequired: false,
		dayStartMinutes: 240,
		shiftsRequired: false,
		idleLockSeconds: 120,
		deviceToken: null,
		deviceLabel: null,
		demo: false,
		locale: null,
		apps: { timeclock: false, reservations: false },
		activeApp: 'pos',
	}
	const paired = (locationId: string | null) => ({
		ok: true as const,
		deviceToken: 'pdv1.secret',
		terminalCode: 'BAR',
		locationId,
		deviceLabel: 'Bar tablet',
		scopeId: 'main',
		signInRequired: true,
		dayStartMinutes: 300,
		shiftsRequired: false,
	})

	it('adopts the server-issued secret, code and label', () => {
		expect(withPairing(base, paired(null))).toMatchObject({
			deviceToken: 'pdv1.secret',
			terminalCode: 'BAR',
			deviceLabel: 'Bar tablet',
		})
	})

	it('locks the location when the server bound the terminal to one', () => {
		expect(withPairing(base, paired('loc-9'))).toMatchObject({
			locationId: 'loc-9',
			locationLocked: true,
		})
	})

	it('adopts the workplace and whether staff must sign in, as the server set them', () => {
		const result = { ...paired(null), scopeId: 'patio', signInRequired: true }
		expect(withPairing(base, result)).toMatchObject({
			scopeId: 'patio',
			signInRequired: true,
		})
		expect(
			withPairing(
				{ ...base, signInRequired: true },
				{ ...paired(null), signInRequired: false },
			),
		).toMatchObject({ signInRequired: false })
	})

	it('adopts when the business day turns over, keeping the current value when the server sends none', () => {
		expect(withPairing(base, paired(null)).dayStartMinutes).toBe(300)
		expect(
			withPairing(base, { ...paired(null), dayStartMinutes: null })
				.dayStartMinutes,
		).toBe(240)
	})

	it('leaves the location free when the terminal is not bound', () => {
		expect(
			withPairing({ ...base, locationId: 'loc-2' }, paired(null)),
		).toMatchObject({ locationId: 'loc-2', locationLocked: false })
	})
})

describe('which servers a till may be pointed at', () => {
	const dev: OriginPolicy = { allowed: [], production: false }
	const prod = (allowed: string[]): OriginPolicy => ({
		allowed,
		production: true,
	})

	it('requires https, except on a developer machine', () => {
		expect(serverOriginProblem('https://api.example.com', dev)).toBeNull()
		expect(serverOriginProblem('http://api.example.com', dev)).toMatch(
			/secure \(https\)/,
		)
		for (const local of [
			'http://localhost:3007',
			'http://127.0.0.1:4711',
			'http://api.menuza.test:2999',
			'http://tenant.localhost',
		])
			expect(serverOriginProblem(local, dev)).toBeNull()
		expect(serverOriginProblem('ftp://api.example.com', dev)).not.toBeNull()
		expect(serverOriginProblem('nonsense', dev)).not.toBeNull()
	})

	it('a production build with no allow-list refuses every server, with a clear reason', () => {
		expect(serverOriginProblem('https://api.example.com', prod([]))).toMatch(
			/VITE_POS_ALLOWED_ORIGINS/,
		)
	})

	it('only the listed servers, when there is a list', () => {
		const policy = prod(['https://api.example.com', 'https://app.example.com'])
		expect(serverOriginProblem('https://api.example.com/', policy)).toBeNull()
		expect(serverOriginProblem('https://evil.example.net', policy)).toMatch(
			/evil\.example\.net is not a server/,
		)
		expect(
			serversProblem(['https://app.example.com', '', undefined], policy),
		).toBeNull()
		expect(
			serversProblem(['https://app.example.com', 'https://x.example'], policy),
		).not.toBeNull()
	})

	it('reads the allow-list as origins, ignoring blanks and junk', () => {
		expect(
			parseAllowedOrigins(
				' https://api.example.com/ , ,javascript:x,http://127.0.0.1:4711/path',
			),
		).toEqual(['https://api.example.com', 'http://127.0.0.1:4711'])
		expect(parseAllowedOrigins(undefined)).toEqual([])
	})
})

describe('pairTerminal', () => {
	afterEach(() => {
		vi.unstubAllGlobals()
		useClock.setState({ skewMs: null })
	})
	const secret = `pdv1.org_1.device_01.${'b'.repeat(43)}`
	const respond = (status: number, body: unknown, headers = {}) =>
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(typeof body === 'string' ? body : JSON.stringify(body), {
					status,
					headers,
				}),
			),
		)

	it('accepts a well-formed answer', async () => {
		respond(201, {
			deviceSecret: secret,
			device: { terminalCode: 'BAR', locationId: null, label: 'Bar' },
		})
		expect(await pairTerminal('https://api.example.com', CODE)).toMatchObject({
			ok: true,
			deviceToken: secret,
			terminalCode: 'BAR',
			scopeId: 'main',
			dayStartMinutes: null,
		})
	})

	it('never stores a 201 that is not a pairing (a captive portal, a proxy)', async () => {
		respond(201, '<html>Welcome</html>')
		expect(await pairTerminal('https://api.example.com', CODE)).toMatchObject({
			ok: false,
		})
		respond(201, { deviceSecret: 'nope', device: { terminalCode: 'T1' } })
		expect(await pairTerminal('https://api.example.com', CODE)).toMatchObject({
			ok: false,
		})
	})

	it('learns how far off the tablet clock is from the server’s Date', async () => {
		const server = new Date(Date.now() + 10 * 60_000)
		respond(401, {}, { Date: server.toUTCString() })
		await pairTerminal('https://api.example.com', CODE)
		expect(clockSkewMs()).toBeGreaterThan(9 * 60_000)
		expect(clockIsOff()).toBe(true)
	})
})
