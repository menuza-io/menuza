import { afterEach, describe, expect, it } from 'vitest'
import { handleDataRequest } from './entry.server.tsx'

describe('entry.server runtime headers', () => {
	const originalCaches = (globalThis as { caches?: unknown }).caches
	const originalDatacenter = process.env.CF_DATACENTER
	const originalRegion = process.env.REGION

	afterEach(() => {
		if (originalCaches !== undefined) {
			;(globalThis as { caches?: unknown }).caches = originalCaches
		} else {
			delete (globalThis as { caches?: unknown }).caches
		}
		if (originalDatacenter !== undefined) {
			process.env.CF_DATACENTER = originalDatacenter
		} else {
			delete process.env.CF_DATACENTER
		}
		if (originalRegion !== undefined) {
			process.env.REGION = originalRegion
		} else {
			delete process.env.REGION
		}
	})

	it('applies cf headers in cloudflare worker runtime without throwing', async () => {
		;(globalThis as { caches?: unknown }).caches = { default: {} }
		const response = new Response('ok')
		const result = await handleDataRequest(response)
		expect(result.headers.get('cf-worker')).toBe('menuza-app')
		expect(result.headers.get('cf-datacenter')).toBe('unknown')
	})

	it('uses process.env.CF_DATACENTER if available in worker runtime', async () => {
		;(globalThis as { caches?: unknown }).caches = { default: {} }
		process.env.CF_DATACENTER = 'iad'
		const response = new Response('ok')
		const result = await handleDataRequest(response)
		expect(result.headers.get('cf-worker')).toBe('menuza-app')
		expect(result.headers.get('cf-datacenter')).toBe('iad')
	})
})
