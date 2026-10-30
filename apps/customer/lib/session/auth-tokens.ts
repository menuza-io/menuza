import { z } from 'zod'
import { decodeJwt } from '../support/jwt'

export type AuthTokens = {
	accessToken: string
	refreshToken: string
}

const storedTokensSchema = z.object({
	accessToken: z.string().min(1),
	refreshToken: z.string().min(1),
})

export function parseStoredTokens(raw: string): AuthTokens | null {
	try {
		const parsed = storedTokensSchema.safeParse(JSON.parse(raw))
		if (!parsed.success) return null
		return parsed.data
	} catch {
		return null
	}
}

export function tokenOrgId(tokens: AuthTokens): string | null {
	return decodeJwt(tokens.accessToken)?.orgId ?? null
}

export function tokenCustomerId(tokens: AuthTokens): string | null {
	return decodeJwt(tokens.accessToken)?.customerId ?? null
}

export function tokenName(tokens: AuthTokens): string | null {
	return decodeJwt(tokens.accessToken)?.name ?? null
}

export function firstName(name: string | null | undefined): string | null {
	return name?.split(' ').find((part) => part.length > 0) ?? null
}
