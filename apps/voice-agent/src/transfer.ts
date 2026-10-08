import { isUsOrCanadaNumber } from '@repo/phone-agent'
import { SipClient } from 'livekit-server-sdk'
import { ENV } from 'varlock/env'
import { phoneTail } from './job-metadata.ts'

/**
 * - `answered`: staff picked up and is now in the room with the caller.
 * - `referred`: the caller left the room through a SIP REFER; whether anyone
 *   answers is out of our hands.
 * - `no_answer`: nobody picked up, or the transfer failed.
 */
export type TransferResult = 'answered' | 'referred' | 'no_answer'

export type TransferDialer = {
	/**
	 * Warm dialers ring staff into the room while the caller listens to the
	 * hold message; cold ones hand the caller off once it has played.
	 */
	readonly warm: boolean
	transfer(
		phone: string,
		options?: { ringSeconds?: number },
	): Promise<TransferResult>
}

/** Default for how long staff phones ring before the caller continues without them. */
export const TRANSFER_RING_SECONDS = 25

/**
 * Hard cap on a warm-transferred call once the agent has left the caller and
 * staff alone. It is fixed rather than the owner's `maxCallMinutes`, which
 * limits the AI conversation (at most 30 minutes) and can be much shorter
 * than a call with a person should be; the cap only bounds the outbound
 * leg's cost if a call is left open.
 */
export const MAX_BRIDGED_CALL_MINUTES = 30

let warnedNoOutboundTrunk = false

export function createSipTransferDialer({
	roomName,
	callId,
	sipParticipantIdentity,
	referOnly = false,
}: {
	roomName: string
	callId: string
	sipParticipantIdentity: string
	/** Always hand off with a SIP REFER, even when an outbound trunk is set. */
	referOnly?: boolean
}): TransferDialer {
	const sip = new SipClient(
		ENV.LIVEKIT_URL,
		ENV.LIVEKIT_API_KEY,
		ENV.LIVEKIT_API_SECRET,
	)
	// The callers check this too; it is repeated here because every dial and
	// REFER passes through, so no path can reach a premium or foreign number.
	const allowed = (phone: string) => {
		if (isUsOrCanadaNumber(phone)) return true
		console.warn('Refusing to dial a number outside the US and Canada', {
			callId,
			phone: phoneTail(phone),
		})
		return false
	}
	const trunkId = referOnly ? undefined : ENV.LIVEKIT_SIP_OUTBOUND_TRUNK_ID
	if (trunkId) {
		return {
			warm: true,
			async transfer(phone, options) {
				if (!allowed(phone)) return 'no_answer'
				const ringSeconds = options?.ringSeconds ?? TRANSFER_RING_SECONDS
				try {
					await sip.createSipParticipant(trunkId, phone, roomName, {
						participantIdentity: `staff-${callId}-${Date.now()}`,
						participantName: 'Staff',
						waitUntilAnswered: true,
						ringingTimeout: ringSeconds,
						timeout: ringSeconds + 10,
						// Backstop for the worker's own bridged-call timer, in case
						// the worker dies while caller and staff are still talking.
						maxCallDuration: MAX_BRIDGED_CALL_MINUTES * 60 + ringSeconds,
					})
					return 'answered'
				} catch (error) {
					console.warn('Staff did not answer the transfer', error)
					return 'no_answer'
				}
			},
		}
	}
	if (!referOnly && !warnedNoOutboundTrunk) {
		warnedNoOutboundTrunk = true
		console.warn(
			'LIVEKIT_SIP_OUTBOUND_TRUNK_ID is not set; transfers use SIP REFER and cannot detect when nobody answers',
		)
	}
	return {
		warm: false,
		async transfer(phone) {
			if (!allowed(phone)) return 'no_answer'
			try {
				await sip.transferSipParticipant(
					roomName,
					sipParticipantIdentity,
					`tel:${phone}`,
					{ playDialtone: true },
				)
				return 'referred'
			} catch (error) {
				console.error('SIP transfer failed', error)
				return 'no_answer'
			}
		},
	}
}
