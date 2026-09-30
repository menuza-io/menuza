/** POS/delivery integration provider ids (control-plane integrations). */
export const POS_PROVIDER_NAMES = [
	'clover',
	'square',
	'toast',
	'ubereats',
	'doordash',
] as const

export type PosProviderName = (typeof POS_PROVIDER_NAMES)[number]

export function isPosProviderName(name: string): name is PosProviderName {
	return (POS_PROVIDER_NAMES as readonly string[]).includes(name)
}
