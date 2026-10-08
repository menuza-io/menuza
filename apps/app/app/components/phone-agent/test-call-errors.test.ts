import { describe, expect, it } from 'vitest'
import {
	isMicrophoneError,
	microphoneErrorMessage,
} from './test-call-errors.ts'

function domError(name: string) {
	return new DOMException('failed', name)
}

describe('microphoneErrorMessage', () => {
	it('tells permission, missing, and busy microphones apart', () => {
		const message = (error: unknown) => microphoneErrorMessage(error).message
		expect(message(domError('NotAllowedError'))).toMatch(/Allow it/)
		expect(message(domError('NotFoundError'))).toMatch(/No microphone/)
		expect(message(domError('OverconstrainedError'))).toMatch(/No microphone/)
		expect(message(domError('NotReadableError'))).toMatch(/another app/)
		expect(message(new TypeError('no mediaDevices'))).toMatch(
			/Couldn't start your microphone/,
		)
		expect(message(undefined)).toMatch(/Couldn't start your microphone/)
	})
})

describe('isMicrophoneError', () => {
	it('recognizes only browser microphone errors', () => {
		expect(isMicrophoneError(domError('NotAllowedError'))).toBe(true)
		expect(isMicrophoneError(domError('NotReadableError'))).toBe(true)
		expect(isMicrophoneError(new Error('signal connection failed'))).toBe(false)
		expect(isMicrophoneError(null)).toBe(false)
	})
})
