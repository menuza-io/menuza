import { isImpersonating } from '@repo/auth'

/**
 * Impersonation substitutes the target user inside `getUserId`, so without
 * this guard an admin's 15-minute grant could leave behind credentials on the
 * target (a password, email, passkey, 2FA secret, backup codes, OAuth link)
 * that keep working after it expires. Same rule as API keys and MCP grants
 * (`$orgSlug_+/mcp.tsx`): stop impersonating first.
 */
export async function refuseCredentialChangeWhileImpersonating(
	request: Request,
) {
	if (await isImpersonating(request)) {
		throw new Response(
			'Stop impersonating before changing sign-in methods or credentials',
			{ status: 403 },
		)
	}
}
