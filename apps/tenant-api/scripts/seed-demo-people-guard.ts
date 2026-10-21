/**
 * Safety rails for `seed-demo-people-orders.ts`. Kept free of any database
 * import so a unit test can exercise them without touching a real file.
 */

export type DemoOrgPreset = {
	id: string
	slug: string
	locationId: string
	locationName: string
	timeZone: string
	currency: string
}

/** The ONLY organizations the demo people/orders seed may write to. */
export const DEMO_ORGS: Readonly<Record<string, DemoOrgPreset>> = {
	'acme-demo': {
		id: 'demoorgus00000000000000001',
		slug: 'acme-demo',
		locationId: 'loc_acme_demo_main',
		locationName: 'Acme Demo Main',
		timeZone: 'America/New_York',
		currency: 'USD',
	},
}

export function resolveDemoOrg(params: {
	slug: string | undefined
	nodeEnv?: string | undefined
}): DemoOrgPreset {
	if (params.nodeEnv === 'production') {
		throw new Error(
			'seed-demo-people-orders is for local development and refuses to run in production.',
		)
	}
	const slug = params.slug ?? ''
	const preset = Object.hasOwn(DEMO_ORGS, slug) ? DEMO_ORGS[slug] : undefined
	if (!preset) {
		throw new Error(
			`Refusing to seed "${slug}": only ${Object.keys(DEMO_ORGS).join(', ')} may be seeded.`,
		)
	}
	return preset
}

/** Last check before any write: the id about to be opened is a whitelisted demo org. */
export function assertWhitelistedOrgId(orgId: string): void {
	if (!Object.values(DEMO_ORGS).some((org) => org.id === orgId)) {
		throw new Error(`Refusing to write to organization id "${orgId}".`)
	}
}
