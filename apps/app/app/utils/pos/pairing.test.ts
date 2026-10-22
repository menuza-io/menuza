import { describe, expect, it } from 'vitest'
import { buildPosPairingUrl } from './pairing.ts'

const CODE = `ppc1.org_1.${'a'.repeat(43)}`

describe('buildPosPairingUrl', () => {
	it('puts everything in the fragment, so no server ever receives the code', () => {
		const url = new URL(
			buildPosPairingUrl({
				posUrl: 'https://pos.example.com/',
				tenantApiUrl: 'https://api-us.example.com/',
				appUrl: 'https://app.example.com',
				slug: 'joes-diner',
				code: CODE,
			}),
		)
		expect(url.origin).toBe('https://pos.example.com')
		expect(url.search).toBe('')
		expect(url.pathname).toBe('/')
		const params = new URLSearchParams(url.hash.slice(1))
		expect(params.get('a')).toBe('https://api-us.example.com')
		expect(params.get('u')).toBe('https://app.example.com')
		expect(params.get('s')).toBe('joes-diner')
		expect(params.get('c')).toBe(CODE)
	})

	it('round-trips through the Station parser', async () => {
		const link = buildPosPairingUrl({
			posUrl: 'https://pos.example.com',
			tenantApiUrl: 'https://api.example.com',
			appUrl: 'https://app.example.com',
			slug: 'x',
			code: CODE,
		})
		const { parsePairingInput } =
			await import('../../../../station/src/lib/pairing.ts')
		expect(parsePairingInput(link)).toEqual({
			code: CODE,
			tenantApiUrl: 'https://api.example.com',
			appUrl: 'https://app.example.com',
			slug: 'x',
		})
	})
})
