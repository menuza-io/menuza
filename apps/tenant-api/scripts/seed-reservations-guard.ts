/**
 * Safety rails for `seed-reservations.ts`. Free of any database import so a
 * unit test can run them without touching a real file.
 *
 * The seed grants an admin, rewrites flags and writes demo guests, so it must
 * never run against anything but a developer's own local databases.
 */
import os from 'node:os'
import path from 'node:path'

/** Organizations the seed knows (demo venues). Others need an explicit opt-in. */
export const SEED_PRESET_SLUGS: readonly string[] = ['acme', 'riyadh-grill']

const repoDb = path.resolve(
	import.meta.dirname,
	'../../../packages/database/db',
)

export function resolveSeedSlug(params: {
	slug: string | undefined
	/** Comma-separated extra slugs from `SEED_RESERVATIONS_ALLOW`. */
	allow?: string | undefined
}): string {
	const slug = params.slug ?? ''
	const allowed = new Set([
		...SEED_PRESET_SLUGS,
		...(params.allow ?? '')
			.split(',')
			.map((entry) => entry.trim())
			.filter(Boolean),
	])
	if (!slug || !allowed.has(slug)) {
		throw new Error(
			`Refusing to seed "${slug}": only ${[...allowed].join(', ')} may be seeded (add others with SEED_RESERVATIONS_ALLOW=slug).`,
		)
	}
	return slug
}

/**
 * An unset NODE_ENV counts as production (a Worker or server often has none),
 * so only an explicit `development` or `test` passes. The databases must be
 * local too: a `file:` control-plane URL and a tenant directory inside this
 * repository's local database folder or the temp directory.
 */
export function assertLocalSeedEnvironment(params: {
	nodeEnv: string | undefined
	databaseUrl: string | undefined
	tenantDbDir: string | undefined
}): void {
	if (params.nodeEnv !== 'development' && params.nodeEnv !== 'test') {
		throw new Error(
			'seed-reservations is for local development: NODE_ENV must be explicitly "development" or "test" (unset counts as production).',
		)
	}
	const url = params.databaseUrl?.trim()
	if (url && !url.startsWith('file:')) {
		throw new Error(
			'seed-reservations refuses a remote DATABASE_URL: only a local file: database may be seeded.',
		)
	}
	const dir = params.tenantDbDir?.trim()
	if (dir) {
		const resolved = path.resolve(dir)
		const inside = (root: string) =>
			resolved === root || resolved.startsWith(root + path.sep)
		if (!inside(repoDb) && !inside(os.tmpdir())) {
			throw new Error(
				`seed-reservations refuses TENANT_DB_DIR "${dir}": it must be inside packages/database/db or the temp directory.`,
			)
		}
	}
}

/** An existing organization is never moved to another region or time zone. */
export function assertRegionUnchanged(params: {
	slug: string
	existing: string | null | undefined
	preset: string
}): void {
	if (params.existing && params.existing !== params.preset) {
		throw new Error(
			`"${params.slug}" exists in region "${params.existing}"; the seed will not change a real organization's data region (preset: "${params.preset}").`,
		)
	}
}
