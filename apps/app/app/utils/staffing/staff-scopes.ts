export type ScopeCurrency = 'USD' | 'CAD' | 'SAR'

/** A scope as the Staff screens see it (control-plane facts only). */
export type StaffScope = {
	id: string
	name: string
	currency: ScopeCurrency
}

/** Control-plane facts about one staffing scope. */
export type OrganizationScopeFacts = {
	id: string
	/** The scope's display name (the organization's name for the implicit one). */
	name: string
	timeZone: string
	currency: ScopeCurrency
	isActive: boolean
}

export type ImportableMember = {
	userId: string
	name: string
	email: string
}

/**
 * The generic module has no per-scope address to derive a currency from, so
 * every implicit scope reports this one. Restaurant locations derive theirs from
 * the location's address (see `restaurant/location-scopes.server.ts`).
 */
export const DEFAULT_SCOPE_CURRENCY = 'USD' as const
