import { SpamError } from 'remix-utils/honeypot/server'
import { ENV } from './package-env.js'

const DEFAULT_NAME_FIELD_NAME = 'name__confirm'
const DEFAULT_VALID_FROM_FIELD_NAME = 'from__confirm'

function webCrypto() {
	const cryptoRef = globalThis.crypto
	if (!cryptoRef?.getRandomValues || !cryptoRef.subtle) {
		throw new Error('Web Crypto API is unavailable')
	}
	return cryptoRef
}

async function encrypt(value: string, seed: string) {
	const cryptoRef = webCrypto()
	const iv = cryptoRef.getRandomValues(new Uint8Array(12))
	const seedBuffer = new TextEncoder().encode(seed)
	const hash = await cryptoRef.subtle.digest('SHA-256', seedBuffer)
	const key = await cryptoRef.subtle.importKey('raw', hash, 'AES-GCM', false, [
		'encrypt',
	])
	const encrypted = await cryptoRef.subtle.encrypt(
		{ name: 'AES-GCM', iv },
		key,
		new TextEncoder().encode(value),
	)
	const resultBuffer = new Uint8Array(iv.byteLength + encrypted.byteLength)
	resultBuffer.set(iv)
	resultBuffer.set(new Uint8Array(encrypted), iv.byteLength)
	return btoa(String.fromCharCode(...resultBuffer))
}

async function decrypt(value: string, seed: string) {
	const cryptoRef = webCrypto()
	const binaryString = atob(value)
	const encryptedBuffer = new Uint8Array(binaryString.length)
	for (let i = 0; i < binaryString.length; i++) {
		encryptedBuffer[i] = binaryString.charCodeAt(i)
	}
	const iv = encryptedBuffer.slice(0, 12)
	const ciphertext = encryptedBuffer.slice(12)
	const seedBuffer = new TextEncoder().encode(seed)
	const hash = await cryptoRef.subtle.digest('SHA-256', seedBuffer)
	const key = await cryptoRef.subtle.importKey(
		'raw',
		hash,
		{ name: 'AES-GCM' },
		false,
		['decrypt'],
	)
	const decrypted = await cryptoRef.subtle.decrypt(
		{ name: 'AES-GCM', iv },
		key,
		ciphertext,
	)
	return new TextDecoder().decode(decrypted)
}

class AppHoneypot {
	#encryptionSeed() {
		return ENV.HONEYPOT_SECRET
	}

	#validFromFieldName() {
		return ENV.NODE_ENV === 'test' ? null : DEFAULT_VALID_FROM_FIELD_NAME
	}

	async getInputProps({
		validFromTimestamp = Date.now(),
	}: { validFromTimestamp?: number } = {}) {
		const validFromFieldName = this.#validFromFieldName()
		return {
			nameFieldName: DEFAULT_NAME_FIELD_NAME,
			validFromFieldName,
			encryptedValidFrom: validFromFieldName
				? await encrypt(String(validFromTimestamp), this.#encryptionSeed())
				: '',
		}
	}

	async check(formData: FormData) {
		const validFromFieldName = this.#validFromFieldName()
		if (
			!formData.has(DEFAULT_NAME_FIELD_NAME) &&
			!(validFromFieldName && formData.has(validFromFieldName))
		) {
			return
		}
		if (!formData.has(DEFAULT_NAME_FIELD_NAME)) {
			throw new SpamError('Missing honeypot input')
		}
		const honeypotValue = formData.get(DEFAULT_NAME_FIELD_NAME)
		if (honeypotValue !== '') throw new SpamError('Honeypot input not empty')
		if (!validFromFieldName) return
		const validFrom = formData.get(validFromFieldName)
		if (!validFrom) throw new SpamError('Missing honeypot valid from input')
		const time = await decrypt(String(validFrom), this.#encryptionSeed())
		const timestamp = Number(time)
		if (!time || Number.isNaN(timestamp) || timestamp <= 0) {
			throw new SpamError('Invalid honeypot valid from input')
		}
		if (timestamp > Date.now()) {
			throw new SpamError('Honeypot valid from is in future')
		}
	}
}

export const honeypot = new AppHoneypot()

export async function checkHoneypot(formData: FormData) {
	try {
		await honeypot.check(formData)
	} catch (error) {
		if (error instanceof SpamError || error instanceof DOMException) {
			throw new Response('Form not submitted properly', { status: 400 })
		}
		throw error
	}
}
