import { describe, expect, it } from 'vitest'
import {
	formatKioskDeviceSecret,
	formatKioskPairingCode,
	kioskPairingFragment,
	parseKioskDeviceSecret,
	parseKioskPairingCode,
	randomKioskToken,
} from './kiosk-credentials.ts'

describe('kiosk credentials', () => {
	it('generates unique 43-character url-safe tokens', () => {
		const tokens = new Set(Array.from({ length: 50 }, () => randomKioskToken()))
		expect(tokens.size).toBe(50)
		for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
	})

	it('round-trips a pairing code', () => {
		const random = randomKioskToken()
		const code = formatKioskPairingCode('org_1-A', random)
		expect(parseKioskPairingCode(code)).toEqual({ orgId: 'org_1-A', random })
	})

	it('round-trips a device secret', () => {
		const random = randomKioskToken()
		const secret = formatKioskDeviceSecret(
			'org1',
			'0b8c5c9e-1111-4222-8333-444455556666',
			random,
		)
		expect(parseKioskDeviceSecret(secret)).toEqual({
			orgId: 'org1',
			deviceId: '0b8c5c9e-1111-4222-8333-444455556666',
			random,
		})
	})

	it('rejects malformed, truncated, and wrong-prefix values', () => {
		const random = randomKioskToken()
		const good = formatKioskDeviceSecret('org1', 'device-id-123', random)
		expect(parseKioskDeviceSecret(good)).not.toBeNull()
		for (const bad of [
			'',
			'kdv1',
			good.replace('kdv1', 'kpc1'),
			good.slice(0, -1),
			`${good}x`,
			good.replace('org1', 'org.1'),
			`${good}\n`,
			' ' + good,
			`kdv1..device-id-123.${random}`,
			null,
			undefined,
			42,
			{},
			'x'.repeat(500),
		]) {
			expect(parseKioskDeviceSecret(bad)).toBeNull()
		}
		const code = formatKioskPairingCode('org1', random)
		expect(parseKioskPairingCode(good)).toBeNull()
		expect(parseKioskPairingCode(code.replace('org1', ''))).toBeNull()
		expect(parseKioskPairingCode(`${code} `)).toBeNull()
	})

	it('refuses to format credentials with separator injection', () => {
		const random = randomKioskToken()
		expect(() => formatKioskPairingCode('a.b', random)).toThrow()
		expect(() =>
			formatKioskDeviceSecret('org', 'dev.ice1234', random),
		).toThrow()
		expect(() => formatKioskPairingCode('org', 'short')).toThrow()
	})

	it('keeps the code in the URL fragment so it never reaches a server', () => {
		const fragment = kioskPairingFragment('ksa', 'kpc1.o.abc')
		expect(fragment.startsWith('#')).toBe(true)
		expect(fragment).toContain('r=ksa')
	})
})
