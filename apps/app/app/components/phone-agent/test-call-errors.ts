import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'

function errorName(error: unknown) {
	return error &&
		typeof error === 'object' &&
		'name' in error &&
		typeof error.name === 'string'
		? error.name
		: null
}

/** Explains a failed microphone request by the browser's error name. */
export function microphoneErrorMessage(error: unknown): MessageDescriptor {
	switch (errorName(error)) {
		case 'NotAllowedError':
		case 'SecurityError':
			return msg`Microphone access is needed for a test call. Allow it in your browser and try again.`
		case 'NotFoundError':
		case 'OverconstrainedError':
			return msg`No microphone was found. Connect one and try again.`
		case 'NotReadableError':
			return msg`Your microphone is being used by another app. Close it and try again.`
		default:
			return msg`Couldn't start your microphone. Check it and try again.`
	}
}

const MICROPHONE_ERROR_NAMES = new Set([
	'NotAllowedError',
	'SecurityError',
	'NotFoundError',
	'OverconstrainedError',
	'NotReadableError',
])

/** True for errors the browser raises when it can't open the microphone. */
export function isMicrophoneError(error: unknown) {
	const name = errorName(error)
	return name !== null && MICROPHONE_ERROR_NAMES.has(name)
}
