import crypto from 'node:crypto'
import { hmacHash } from './secrets.ts'

/**
 * Seals ZATCA secrets at rest (EGS signing keys, CSID secrets) with
 * AES-256-GCM. The key is derived from AUTH_HMAC_SECRET, which every
 * tenant-api node already holds and never leaves the node.
 */

const key = () => Buffer.from(hmacHash('zatca-seal-v1'), 'hex')

export function seal(plain: string): string {
	const iv = crypto.randomBytes(12)
	const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv)
	const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
	return [
		'v1',
		iv.toString('base64'),
		cipher.getAuthTag().toString('base64'),
		body.toString('base64'),
	].join('.')
}

export function unseal(sealed: string): string {
	const [version, iv, tag, body] = sealed.split('.')
	if (version !== 'v1' || !iv || !tag || !body)
		throw new Error('Unknown sealed value')
	const decipher = crypto.createDecipheriv(
		'aes-256-gcm',
		key(),
		Buffer.from(iv, 'base64'),
	)
	decipher.setAuthTag(Buffer.from(tag, 'base64'))
	return Buffer.concat([
		decipher.update(Buffer.from(body, 'base64')),
		decipher.final(),
	]).toString('utf8')
}
