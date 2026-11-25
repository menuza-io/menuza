/** The two organizations of the catering tests (no imports, so a `vi.mock` factory can load it). */
export type Org = {
	id: string
	slug: string
	customDomain: string | null
	hasProvisionedDb: boolean
	dataRegion: 'us' | 'ksa'
}

export const ORIGIN = 'https://acme.example.com'
export const OTHER_ORIGIN = 'https://other.example.com'

export const ORG_A: Org = {
	id: 'org_catering_a',
	slug: 'acme',
	customDomain: null,
	hasProvisionedDb: true,
	dataRegion: 'us',
}
export const ORG_B: Org = {
	id: 'org_catering_b',
	slug: 'other',
	customDomain: null,
	hasProvisionedDb: true,
	dataRegion: 'us',
}

export function orgForBrowser(
	origin: string | undefined,
	identity: { slug?: string; host?: string } | undefined,
): Org | null {
	if (origin === ORIGIN && identity?.slug === ORG_A.slug) return ORG_A
	if (origin === OTHER_ORIGIN && identity?.slug === ORG_B.slug) return ORG_B
	return null
}

export function orgById(id: string): Org | null {
	return id === ORG_A.id ? ORG_A : id === ORG_B.id ? ORG_B : null
}
