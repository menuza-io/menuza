import crypto from 'node:crypto'

/** Fixed PKCE pair so MCP tests can issue and redeem authorization codes. */
export const TEST_CODE_VERIFIER =
	'test-code-verifier-0123456789-abcdefghijklmnopqrstuvwxyz'

export const TEST_PKCE_CHALLENGE = {
	codeChallenge: crypto
		.createHash('sha256')
		.update(TEST_CODE_VERIFIER)
		.digest('base64url'),
	codeChallengeMethod: 'S256',
} as const
