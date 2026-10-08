import { describe, expect, it } from 'vitest'
import { liveKitConnectSrc } from './livekit-csp.ts'

describe('liveKitConnectSrc', () => {
	it('allows the WebSocket and HTTPS origins of the LiveKit host', () => {
		expect(liveKitConnectSrc('wss://acme.livekit.cloud')).toEqual([
			'wss://acme.livekit.cloud',
			'https://acme.livekit.cloud',
		])
		expect(liveKitConnectSrc('https://rtc.example.com:7443/path')).toEqual([
			'https://rtc.example.com:7443',
			'wss://rtc.example.com:7443',
		])
	})

	it('keeps local dev servers on plain ws and http', () => {
		expect(liveKitConnectSrc('ws://localhost:7880')).toEqual([
			'ws://localhost:7880',
			'http://localhost:7880',
		])
	})

	it('adds nothing when LiveKit is not configured or the URL is unusable', () => {
		expect(liveKitConnectSrc(undefined)).toEqual([])
		expect(liveKitConnectSrc('')).toEqual([])
		expect(liveKitConnectSrc('not a url')).toEqual([])
		expect(liveKitConnectSrc('ftp://example.com')).toEqual([])
	})
})
