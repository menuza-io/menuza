/** A scope as the Staff screens see it (control-plane facts only). */
export type StaffScope = {
	id: string
	name: string
	currency: 'USD' | 'CAD' | 'SAR'
}

export type ImportableMember = {
	userId: string
	name: string
	email: string
}

/**
 * The generic module has no per-scope address to derive a currency from, so
 * every workplace reports this one. A vertical that knows better supplies its own.
 */
export const DEFAULT_SCOPE_CURRENCY = 'USD' as const
