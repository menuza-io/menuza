import { ENV } from './env.js'
export type EmailProvider = 'resend' | 'oci'

/**
 * Controls how `sendEmail()` delivers mail (App/Admin transactional + platform
 * marketing). Tenant customer marketing on tenant-api always uses OCI directly.
 */
export function getEmailProvider(): EmailProvider {
	const raw = ENV.EMAIL_PROVIDER?.trim().toLowerCase()
	return raw === 'oci' ? 'oci' : 'resend'
}

export function isOciEmailProvider(): boolean {
	return getEmailProvider() === 'oci'
}
