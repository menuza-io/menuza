import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	createSipTransferDialer,
	MAX_BRIDGED_CALL_MINUTES,
	TRANSFER_RING_SECONDS,
} from './transfer.ts'

const mocks = vi.hoisted(() => ({
	ENV: {
		LIVEKIT_URL: 'wss://livekit.test',
		LIVEKIT_API_KEY: 'key',
		LIVEKIT_API_SECRET: 'secret',
		LIVEKIT_SIP_OUTBOUND_TRUNK_ID: 'trunk_1' as string | undefined,
	},
	sip: {
		createSipParticipant: vi.fn(async () => ({})),
		transferSipParticipant: vi.fn(async () => undefined),
	},
}))
vi.mock('varlock/env', () => ({ ENV: mocks.ENV }))
vi.mock('livekit-server-sdk', () => ({
	SipClient: vi.fn(function SipClient() {
		return mocks.sip
	}),
}))

const options = {
	roomName: 'room_1',
	callId: 'call_1',
	sipParticipantIdentity: 'sip_caller',
}

describe('createSipTransferDialer', () => {
	beforeEach(() => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		vi.spyOn(console, 'error').mockImplementation(() => undefined)
		mocks.ENV.LIVEKIT_SIP_OUTBOUND_TRUNK_ID = 'trunk_1'
		mocks.sip.createSipParticipant.mockReset()
		mocks.sip.createSipParticipant.mockResolvedValue({})
		mocks.sip.transferSipParticipant.mockReset()
		mocks.sip.transferSipParticipant.mockResolvedValue(undefined)
	})
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('rings staff into the room and waits for them to answer', async () => {
		const dialer = createSipTransferDialer(options)
		expect(dialer.warm).toBe(true)
		await expect(
			dialer.transfer('+15553334444', { ringSeconds: 20 }),
		).resolves.toBe('answered')
		expect(mocks.sip.createSipParticipant).toHaveBeenCalledWith(
			'trunk_1',
			'+15553334444',
			'room_1',
			expect.objectContaining({
				waitUntilAnswered: true,
				ringingTimeout: 20,
				timeout: 30,
				maxCallDuration: MAX_BRIDGED_CALL_MINUTES * 60 + 20,
			}),
		)
	})

	it('uses the default ring time and reports no answer when the dial fails', async () => {
		mocks.sip.createSipParticipant.mockRejectedValueOnce(new Error('busy'))
		const dialer = createSipTransferDialer(options)
		await expect(dialer.transfer('+15553334444')).resolves.toBe('no_answer')
		expect(mocks.sip.createSipParticipant).toHaveBeenCalledWith(
			'trunk_1',
			'+15553334444',
			'room_1',
			expect.objectContaining({ ringingTimeout: TRANSFER_RING_SECONDS }),
		)
	})

	it('falls back to a cold SIP REFER without an outbound trunk', async () => {
		mocks.ENV.LIVEKIT_SIP_OUTBOUND_TRUNK_ID = undefined
		const dialer = createSipTransferDialer(options)
		expect(dialer.warm).toBe(false)
		await expect(dialer.transfer('+15553334444')).resolves.toBe('referred')
		expect(mocks.sip.transferSipParticipant).toHaveBeenCalledWith(
			'room_1',
			'sip_caller',
			'tel:+15553334444',
			{ playDialtone: true },
		)
	})

	it('reports a failed REFER as no answer', async () => {
		mocks.ENV.LIVEKIT_SIP_OUTBOUND_TRUNK_ID = undefined
		mocks.sip.transferSipParticipant.mockRejectedValueOnce(new Error('nope'))
		const dialer = createSipTransferDialer(options)
		await expect(dialer.transfer('+15553334444')).resolves.toBe('no_answer')
	})

	it('refuses to ring or refer numbers outside the US and Canada', async () => {
		const warm = createSipTransferDialer(options)
		for (const phone of ['+447700900123', '+18765550123', '+19005550123']) {
			await expect(warm.transfer(phone)).resolves.toBe('no_answer')
		}
		mocks.ENV.LIVEKIT_SIP_OUTBOUND_TRUNK_ID = undefined
		const cold = createSipTransferDialer(options)
		await expect(cold.transfer('+5215512345678')).resolves.toBe('no_answer')
		expect(mocks.sip.createSipParticipant).not.toHaveBeenCalled()
		expect(mocks.sip.transferSipParticipant).not.toHaveBeenCalled()
		expect(console.warn).toHaveBeenCalledWith(
			'Refusing to dial a number outside the US and Canada',
			{ callId: 'call_1', phone: '***0123' },
		)
	})

	it('can be forced to hand off with a REFER even with an outbound trunk', async () => {
		const dialer = createSipTransferDialer({ ...options, referOnly: true })
		expect(dialer.warm).toBe(false)
		await expect(dialer.transfer('+15553334444')).resolves.toBe('referred')
		expect(mocks.sip.createSipParticipant).not.toHaveBeenCalled()
		expect(mocks.sip.transferSipParticipant).toHaveBeenCalledTimes(1)
	})
})
