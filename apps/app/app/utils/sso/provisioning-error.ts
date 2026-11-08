/**
 * The identity provider signed the user in, but this organization's SSO policy
 * refuses the account (no allowed domains, a domain or link mismatch,
 * auto-provisioning off). The message is written for the person signing in and
 * is safe to show; token, nonce and signature failures are not this error.
 */
export class SSOProvisioningError extends Error {
	override name = 'SSOProvisioningError'
}

export function isSSOProvisioningError(
	error: unknown,
): error is SSOProvisioningError {
	return error instanceof SSOProvisioningError
}
