import { getDomainUrl } from '@repo/common'
import { db, MCPClient } from '@repo/database'
import { getClientIp } from '@repo/security'
import { type ActionFunctionArgs } from 'react-router'
import {
	generateToken,
	validateMCPRedirectUriFormat,
} from '#app/utils/mcp/oauth.server.ts'
import {
	checkRateLimit,
	createRateLimitResponse,
} from '#app/utils/rate-limit.server.ts'

/**
 * OAuth Dynamic Client Registration Endpoint (RFC 7591)
 *
 * This endpoint handles dynamic client registration for MCP clients.
 * Each client receives a unique client_id and their redirect URIs are
 * stored for validation during the authorization flow.
 *
 * NOTE: This endpoint is PUBLIC (no authentication required) as it's part of OAuth discovery.
 */
const REGISTER_RATE_LIMIT = {
	scope: 'mcp-register',
	maxRequests: 20,
	windowMs: 60 * 60 * 1000,
}
const MAX_REDIRECT_URIS = 10

export async function action({ request }: ActionFunctionArgs) {
	const limit = await checkRateLimit(
		{ type: 'ip', value: getClientIp(request) },
		REGISTER_RATE_LIMIT,
	)
	if (!limit.allowed) return createRateLimitResponse(limit.resetAt)

	try {
		const body = (await request.json()) as Record<string, any>

		const baseUrl = getDomainUrl(request)

		// Validate redirect_uris
		const redirectUris = Array.isArray(body.redirect_uris)
			? body.redirect_uris.filter(
					(uri: unknown): uri is string =>
						typeof uri === 'string' &&
						uri.length > 0 &&
						uri.length <= 2048 &&
						validateMCPRedirectUriFormat(uri).isValid,
				)
			: []
		if (redirectUris.length === 0 || redirectUris.length > MAX_REDIRECT_URIS) {
			return Response.json(
				{
					error: 'invalid_redirect_uri',
					error_description: `Provide 1-${MAX_REDIRECT_URIS} valid redirect_uris`,
				},
				{ status: 400 },
			)
		}

		// Generate unique client ID
		const clientId = generateToken()
		const clientName =
			typeof body.client_name === 'string' && body.client_name.trim()
				? body.client_name.trim().slice(0, 100)
				: 'MCP Client'

		// Store client registration in database
		await db.insert(MCPClient).values({
			clientId,
			clientName,
			redirectUris: JSON.stringify(redirectUris),
		})

		// Return the registration response with the OAuth endpoints
		return Response.json(
			{
				client_id: clientId,
				client_name: clientName,
				redirect_uris: redirectUris,
				grant_types: ['authorization_code', 'refresh_token'],
				response_types: ['code'],
				token_endpoint_auth_method: 'none',
				// Include the OAuth endpoints in the response
				authorization_endpoint: `${baseUrl}/mcp/authorize`,
				token_endpoint: `${baseUrl}/mcp/token`,
			},
			{
				status: 201,
				headers: {
					'Content-Type': 'application/json',
					'Cache-Control': 'no-store',
				},
			},
		)
	} catch (error) {
		console.error('[MCP Register] Error:', error)
		return Response.json(
			{
				error: 'invalid_request',
				error_description: 'Invalid registration request',
			},
			{
				status: 400,
				headers: {
					'Content-Type': 'application/json',
				},
			},
		)
	}
}

/**
 * Handle GET requests - not supported for registration
 */
export async function loader() {
	return Response.json(
		{
			error: 'invalid_request',
			error_description: 'GET method not supported for client registration',
		},
		{
			status: 405,
			headers: {
				'Content-Type': 'application/json',
			},
		},
	)
}
