import { SetCookie } from '@mjackson/headers'
import { ENV } from '../package-env.ts'
import { createId as cuid } from '@paralleldrive/cuid2'
import { redirect } from 'react-router'
import { GoogleStrategy, type GoogleProfile } from '@coji/remix-auth-google'
import { z } from 'zod'
import { cache, cachified } from '@repo/cache'
import { type Timings } from '@repo/common'
import { MOCK_CODE_GOOGLE_HEADER, MOCK_CODE_GOOGLE } from '../constants.ts'
import { type AuthProvider, type ProviderUser } from '../provider.ts'

const GoogleUserSchema = z.object({
	id: z.string(),
	email: z.string(),
	name: z.string().optional(),
	picture: z.string().optional(),
})

const GoogleUserParseResult = z
	.object({
		success: z.literal(true),
		data: GoogleUserSchema,
	})
	.or(
		z.object({
			success: z.literal(false),
		}),
	)

const shouldMock =
	ENV.GOOGLE_CLIENT_ID?.startsWith('MOCK_') || ENV.NODE_ENV === 'test'

export class GoogleProvider implements AuthProvider {
	getAuthStrategy() {
		if (
			!ENV.GOOGLE_CLIENT_ID ||
			!ENV.GOOGLE_CLIENT_SECRET ||
			!ENV.GOOGLE_REDIRECT_URI
		) {
			console.log(
				'Google OAuth strategy not available because environment variables are not set',
			)
			return null
		}
		return new GoogleStrategy<ProviderUser>(
			{
				clientId: ENV.GOOGLE_CLIENT_ID,
				clientSecret: ENV.GOOGLE_CLIENT_SECRET,
				redirectURI: ENV.GOOGLE_REDIRECT_URI,
			},
			async ({ profile }: { profile: GoogleProfile }) => {
				return {
					id: profile.id,
					email: profile.emails?.[0]?.value ?? '',
					name: profile.displayName,
					username: profile.emails?.[0]?.value?.split('@')[0] ?? '',
					imageUrl: profile.photos?.[0]?.value,
				}
			},
		)
	}

	async resolveConnectionData(
		providerId: string,
		{ timings }: { timings?: Timings } = {},
	) {
		// For Google, we don't have a public API to resolve user data by ID
		// so we'll return cached data or basic info
		const result = await cachified({
			key: `connection-data:google:${providerId}`,
			cache,
			timings,
			ttl: 1000 * 60,
			swr: 1000 * 60 * 60 * 24 * 7,
			async getFreshValue() {
				// Since Google doesn't provide a public API to get user by ID,
				// we'll return a basic structure
				const result = {
					success: true as const,
					data: {
						id: providerId,
						email: '', // Would need to be stored from initial auth
						name: '',
						picture: '',
					},
				}
				return result
			},
			checkValue: GoogleUserParseResult,
		})

		return {
			displayName:
				result.success && result.data.name ? result.data.name : 'Google User',
			link: null, // Google doesn't have public profile URLs like GitHub
		} as const
	}

	async handleMockAction(request: Request) {
		if (!shouldMock) return

		const state = cuid()
		// allows us to inject a code when running e2e tests,
		// but falls back to a pre-defined constant
		const code =
			request.headers.get(MOCK_CODE_GOOGLE_HEADER) || MOCK_CODE_GOOGLE
		const searchParams = new URLSearchParams({ code, state })
		let cookie = new SetCookie({
			name: 'google',
			value: searchParams.toString(),
			path: '/',
			sameSite: 'Lax',
			httpOnly: true,
			maxAge: 60 * 10,
			secure: ENV.NODE_ENV === 'production' || undefined,
		})
		throw redirect(`/auth/google/callback?${searchParams}`, {
			headers: {
				'Set-Cookie': cookie.toString(),
			},
		})
	}
}
