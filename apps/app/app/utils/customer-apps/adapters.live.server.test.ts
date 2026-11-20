import { describe, expect, it } from 'vitest'
import { PublicStoreAdapter } from './adapters.live.server.ts'

describe('PublicStoreAdapter play listing', () => {
	it('does not treat a consent page as live without the package id', async () => {
		const adapter = new PublicStoreAdapter(async () =>
			Response.json(
				{},
				{ status: 200, headers: { 'Content-Type': 'text/html' } },
			),
		)
		const snapshot = await adapter.fetch(
			{
				iosBundleId: 'com.acme.app',
				androidPackage: 'com.acme.app',
				storeUrls: { app_store: null, play_store: null },
			},
			'play_store',
		)
		expect(snapshot.status).toBe('unknown')
	})

	it('marks live when the package id appears in the page', async () => {
		const adapter = new PublicStoreAdapter(async () =>
			new Response('<html>com.acme.live</html>', {
				status: 200,
				headers: { 'Content-Type': 'text/html' },
			}),
		)
		const snapshot = await adapter.fetch(
			{
				iosBundleId: 'com.acme.app',
				androidPackage: 'com.acme.live',
				storeUrls: { app_store: null, play_store: null },
			},
			'play_store',
		)
		expect(snapshot.status).toBe('live')
	})
})