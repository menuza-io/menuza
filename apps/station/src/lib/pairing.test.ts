import { describe, expect, it } from 'vitest'
import { type PosSettings } from './config.ts'
import { parsePairingInput, withPairing } from './pairing.ts'

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

	it('drops server addresses that are not http(s) origins rather than trusting them', () => {
		const parsed = parsePairingInput(
			link({
				a: 'javascript:alert(1)',
				u: 'file:///etc/passwd',
				s: 'x',
				c: CODE,
			}),
		)
		expect(parsed).toEqual({
			code: CODE,
			tenantApiUrl: undefined,
			appUrl: undefined,
			slug: 'x',
		})
		expect(
			parsePairingInput(link({ a: 'not a url', c: CODE }))?.tenantApiUrl,
		).toBeUndefined()
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
