import { requireUserWithPermission } from '@repo/auth'
import {
	type AccountCheckResult,
	type AccountSnapshot,
	CUSTOMER_APP_CREDENTIAL_KINDS,
	CUSTOMER_APP_PERMISSION,
	CUSTOMER_APP_PLATFORMS,
	CUSTOMER_APP_PUBLISHERS,
	CUSTOMER_APP_STORES,
	credentialStatuses,
	evaluateAccountChecks,
	identifiersLocked,
	liveStores,
	readStoreUrls,
	rebuildRequired,
	showsAccountChecks,
	summarizeRelease,
	type BuildOutcome,
} from '@repo/common/customer-app'
import {
	and,
	asc,
	CustomerApp,
	CustomerAppBuild,
	CustomerAppCredential,
	CustomerAppStoreHealth,
	CustomerAppStoreReview,
	db,
	desc,
	eq,
	inArray,
	Organization,
} from '@repo/database'
import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'
import { postToApp } from '#app/utils/app-service.server.ts'

/**
 * Admin, Customer apps (#156). Admin reads the registry straight from the
 * control plane and never selects a credential's ciphertext (the loaders name
 * their columns). Every change goes through the App, which owns the
 * credential encryption key and the build and store adapters. The permission
 * is `update:customer_app:any`.
 */

export type CustomerAppAdminResult =
	| {
			ok: true
			/** Per-app outcomes of a release or retry. */
			outcomes?: BuildOutcome[]
			summary?: ReturnType<typeof summarizeRelease>
			valid?: boolean
			created?: string
	  }
	| { ok: false; code: string; message: string }

const BUILD_RANK: Record<string, number> = {
	failed: 0,
	running: 1,
	queued: 2,
	cancelled: 3,
	succeeded: 4,
}

export async function listLoader({ request }: LoaderFunctionArgs) {
	await requireUserWithPermission(request, CUSTOMER_APP_PERMISSION)
	const apps = await db
		.select({
			id: CustomerApp.id,
			organizationId: CustomerApp.organizationId,
			organization: Organization.name,
			organizationRegion: Organization.dataRegion,
			displayName: CustomerApp.displayName,
			slug: CustomerApp.slug,
			iosBundleId: CustomerApp.iosBundleId,
			androidPackage: CustomerApp.androidPackage,
			marketingVersion: CustomerApp.marketingVersion,
			status: CustomerApp.status,
			publisher: CustomerApp.publisher,
			storeUrls: CustomerApp.storeUrls,
			accountSnapshot: CustomerApp.accountSnapshot,
		})
		.from(CustomerApp)
		.innerJoin(Organization, eq(Organization.id, CustomerApp.organizationId))
		.orderBy(asc(Organization.name))
	const ids = apps.map((app) => app.id)
	// D1 binds at most 100 values per statement: ask in chunks.
	const builds: Array<{
		appId: string
		release: string
		platform: string
		status: string
		dataRegion: string
		createdAt: Date
	}> = []
	const health: Array<{
		appId: string
		store: string
		status: string
		version: string | null
		ratingX100: number | null
		ratingCount: number
		lastCheckedAt: Date | null
	}> = []
	for (let start = 0; start < ids.length; start += 90) {
		const part = ids.slice(start, start + 90)
		builds.push(
			...(await db
				.select({
					appId: CustomerAppBuild.appId,
					release: CustomerAppBuild.release,
					platform: CustomerAppBuild.platform,
					status: CustomerAppBuild.status,
					dataRegion: CustomerAppBuild.dataRegion,
					createdAt: CustomerAppBuild.createdAt,
				})
				.from(CustomerAppBuild)
				.where(inArray(CustomerAppBuild.appId, part))
				.orderBy(desc(CustomerAppBuild.createdAt))),
		)
		health.push(
			...(await db
				.select({
					appId: CustomerAppStoreHealth.appId,
					store: CustomerAppStoreHealth.store,
					status: CustomerAppStoreHealth.status,
					version: CustomerAppStoreHealth.version,
					ratingX100: CustomerAppStoreHealth.ratingX100,
					ratingCount: CustomerAppStoreHealth.ratingCount,
					lastCheckedAt: CustomerAppStoreHealth.lastCheckedAt,
				})
				.from(CustomerAppStoreHealth)
				.where(inArray(CustomerAppStoreHealth.appId, part))),
		)
	}
	// Organizations that could get an app: site published, none yet.
	const taken = new Set(apps.map((app) => app.organizationId))
	const candidates = (
		await db
			.select({
				id: Organization.id,
				name: Organization.name,
				slug: Organization.slug,
			})
			.from(Organization)
			.where(
				and(
					eq(Organization.sitePublished, true),
					eq(Organization.active, true),
				),
			)
			.orderBy(asc(Organization.name))
			.limit(500)
	).filter((organization) => !taken.has(organization.id))
	const now = Date.now()
	return {
		candidates,
		apps: apps.map((app) => {
			const own = builds.filter((build) => build.appId === app.id)
			const latestRelease = own[0]?.release ?? null
			const latest = own.filter((build) => build.release === latestRelease)
			const lastGood = own.find((build) => build.status === 'succeeded')
			const checks =
				app.accountSnapshot && showsAccountChecks(app.publisher)
					? evaluateAccountChecks(
							JSON.parse(app.accountSnapshot) as AccountSnapshot,
							now,
						)
					: []
			return {
				id: app.id,
				organization: app.organization,
				displayName: app.displayName,
				iosBundleId: app.iosBundleId,
				androidPackage: app.androidPackage,
				marketingVersion: app.marketingVersion,
				status: app.status,
				publisher: app.publisher,
				latestRelease,
				latestBuilds: latest
					.map((build) => ({ platform: build.platform, status: build.status }))
					.sort(
						(a, b) => (BUILD_RANK[a.status] ?? 9) - (BUILD_RANK[b.status] ?? 9),
					),
				stores: CUSTOMER_APP_STORES.map((store) => {
					const row = health.find(
						(h) => h.appId === app.id && h.store === store,
					)
					return {
						store,
						status: row?.status ?? 'unknown',
						version: row?.version ?? null,
						ratingX100: row?.ratingX100 ?? null,
						ratingCount: row?.ratingCount ?? 0,
						lastCheckedAt: row?.lastCheckedAt?.toISOString() ?? null,
					}
				}),
				rebuildRequired: rebuildRequired({
					organizationRegion: app.organizationRegion,
					lastBuiltRegion: lastGood?.dataRegion ?? null,
				}),
				accountProblems: checks.filter((check) => check.status !== 'pass')
					.length,
			}
		}),
	}
}

const StarsSchema = z.coerce.number().int().min(1).max(5).optional()

export async function detailLoader({ request, params }: LoaderFunctionArgs) {
	await requireUserWithPermission(request, CUSTOMER_APP_PERMISSION)
	const [app] = await db
		.select()
		.from(CustomerApp)
		.where(eq(CustomerApp.id, params.appId ?? ''))
		.limit(1)
	if (!app) throw new Response('Not Found', { status: 404 })
	const [organization] = await db
		.select({
			name: Organization.name,
			slug: Organization.slug,
			dataRegion: Organization.dataRegion,
		})
		.from(Organization)
		.where(eq(Organization.id, app.organizationId))
		.limit(1)
	const stars = StarsSchema.safeParse(
		new URL(request.url).searchParams.get('stars') ?? undefined,
	)
	const [credentialRows, builds, health, reviews] = await Promise.all([
		// Names its columns: the ciphertext is never selected.
		db
			.select({
				kind: CustomerAppCredential.kind,
				uploadedAt: CustomerAppCredential.uploadedAt,
			})
			.from(CustomerAppCredential)
			.where(eq(CustomerAppCredential.appId, app.id)),
		db
			.select({
				id: CustomerAppBuild.id,
				release: CustomerAppBuild.release,
				platform: CustomerAppBuild.platform,
				status: CustomerAppBuild.status,
				attempts: CustomerAppBuild.attempts,
				logUrl: CustomerAppBuild.logUrl,
				error: CustomerAppBuild.error,
				dataRegion: CustomerAppBuild.dataRegion,
				createdAt: CustomerAppBuild.createdAt,
				finishedAt: CustomerAppBuild.finishedAt,
			})
			.from(CustomerAppBuild)
			.where(eq(CustomerAppBuild.appId, app.id))
			.orderBy(desc(CustomerAppBuild.createdAt))
			.limit(60),
		db
			.select()
			.from(CustomerAppStoreHealth)
			.where(eq(CustomerAppStoreHealth.appId, app.id)),
		db
			.select()
			.from(CustomerAppStoreReview)
			.where(
				stars.success && stars.data
					? and(
							eq(CustomerAppStoreReview.appId, app.id),
							eq(CustomerAppStoreReview.rating, stars.data),
						)
					: eq(CustomerAppStoreReview.appId, app.id),
			)
			.orderBy(desc(CustomerAppStoreReview.reviewedAt))
			.limit(50),
	])
	const urls = readStoreUrls(app.storeUrls)
	let snapshot: AccountSnapshot | null = null
	try {
		snapshot = app.accountSnapshot
			? (JSON.parse(app.accountSnapshot) as AccountSnapshot)
			: null
	} catch {
		snapshot = null
	}
	const lastGood = builds.find((build) => build.status === 'succeeded')
	const checks: AccountCheckResult[] = snapshot
		? evaluateAccountChecks(snapshot, Date.now())
		: []
	const listing = (() => {
		try {
			return JSON.parse(app.listingText ?? '{}') as {
				subtitle?: string
				description?: string
			}
		} catch {
			return {}
		}
	})()
	return {
		organization,
		app: {
			id: app.id,
			slug: app.slug,
			displayName: app.displayName,
			iosBundleId: app.iosBundleId,
			androidPackage: app.androidPackage,
			marketingVersion: app.marketingVersion,
			iconBackground: app.iconBackground,
			status: app.status,
			publisher: app.publisher,
			appleTeamId: app.appleTeamId ?? '',
			androidSha256: app.androidSha256
				? (JSON.parse(app.androidSha256) as string[])
				: [],
			storeUrls: urls,
			listing: {
				subtitle: listing.subtitle ?? '',
				description: listing.description ?? '',
			},
			locked: identifiersLocked(app),
			publishedAt: app.publishedAt?.toISOString() ?? null,
		},
		credentials: credentialStatuses(credentialRows),
		builds: builds.map((build) => ({
			...build,
			createdAt: build.createdAt.toISOString(),
			finishedAt: build.finishedAt?.toISOString() ?? null,
		})),
		stores: CUSTOMER_APP_STORES.map((store) => {
			const row = health.find((h) => h.store === store)
			return {
				store,
				status: row?.status ?? 'unknown',
				version: row?.version ?? null,
				ratingX100: row?.ratingX100 ?? null,
				ratingCount: row?.ratingCount ?? 0,
				lastCheckedAt: row?.lastCheckedAt?.toISOString() ?? null,
				lastError: row?.lastError ?? null,
			}
		}),
		live: liveStores({ status: app.status, storeUrls: urls, health }),
		reviews: reviews.map((review) => ({
			id: review.id,
			store: review.store,
			rating: review.rating,
			title: review.title,
			body: review.body,
			appVersion: review.appVersion,
			reviewedAt: review.reviewedAt.toISOString(),
		})),
		starFilter: stars.success ? (stars.data ?? null) : null,
		rebuildRequired: rebuildRequired({
			organizationRegion: organization?.dataRegion ?? 'us',
			lastBuiltRegion: lastGood?.dataRegion ?? null,
		}),
		snapshot,
		checks,
		accountChecksVisibleToRestaurant: showsAccountChecks(app.publisher),
	}
}

const optionalText = z
	.string()
	.trim()
	.transform((value) => (value === '' ? undefined : value))
	.optional()
const triState = z
	.enum(['yes', 'no', 'unknown'])
	.transform((value) => (value === 'unknown' ? null : value === 'yes'))

const ActionSchema = z.discriminatedUnion('_action', [
	z.object({
		_action: z.literal('create'),
		organizationId: z.string().min(1).max(64),
	}),
	z.object({
		_action: z.literal('update'),
		appId: z.string().min(1).max(64),
		displayName: optionalText,
		iosBundleId: optionalText,
		androidPackage: optionalText,
		marketingVersion: optionalText,
		iconBackground: optionalText,
		publisher: z.enum(CUSTOMER_APP_PUBLISHERS),
		appleTeamId: z.string().trim().max(10).optional(),
		androidSha256: z.string().max(1000).optional(),
		subtitle: z.string().max(80).optional(),
		description: z.string().max(4000).optional(),
		appStoreUrl: z.string().trim().max(500).optional(),
		playStoreUrl: z.string().trim().max(500).optional(),
	}),
	z.object({ _action: z.literal('delete'), appId: z.string().min(1).max(64) }),
	z.object({
		_action: z.literal('archive'),
		appId: z.string().min(1).max(64),
		archived: z.enum(['true', 'false']),
	}),
	z.object({
		_action: z.literal('credential-apns'),
		appId: z.string().min(1).max(64),
		key: z.string().max(4000),
		keyId: z.string().trim().max(20),
		teamId: z.string().trim().max(20),
	}),
	z.object({
		_action: z.literal('credential-fcm'),
		appId: z.string().min(1).max(64),
		serviceAccount: z.string().max(8000),
	}),
	z.object({
		_action: z.literal('credential-remove'),
		appId: z.string().min(1).max(64),
		kind: z.enum(CUSTOMER_APP_CREDENTIAL_KINDS),
	}),
	z.object({
		_action: z.literal('credential-check'),
		appId: z.string().min(1).max(64),
		kind: z.enum(CUSTOMER_APP_CREDENTIAL_KINDS),
	}),
	z.object({
		_action: z.literal('build'),
		appId: z.string().min(1).max(64),
		release: z.string().trim().max(40),
		platform: z.enum([...CUSTOMER_APP_PLATFORMS, 'both']).default('both'),
	}),
	z.object({
		_action: z.literal('release'),
		release: z.string().trim().max(40),
	}),
	z.object({
		_action: z.literal('retry'),
		release: z.string().trim().max(40),
		appId: z.string().min(1).max(64).optional(),
	}),
	z.object({
		_action: z.literal('refresh-health'),
		appId: z.string().min(1).max(64),
	}),
	z.object({
		_action: z.literal('account'),
		appId: z.string().min(1).max(64),
		expiresOn: z.string().trim().max(10).optional(),
		termsAccepted: triState,
		paymentTermsAccepted: triState,
		accessOk: triState,
	}),
])

async function app(
	body: Record<string, unknown>,
): Promise<
	| { ok: true; body: Record<string, unknown> }
	| { ok: false; code: string; message: string }
> {
	const result = await postToApp('/resources/customer-apps/command', body, {
		timeoutMs: 60_000,
	})
	if (result.status === 'not_configured') {
		return {
			ok: false,
			code: 'app_not_configured',
			message: 'APP_URL or INTERNAL_COMMAND_TOKEN is not set.',
		}
	}
	if (result.status === 'unreachable') {
		return {
			ok: false,
			code: 'app_unreachable',
			message: 'The App did not answer.',
		}
	}
	const json = (await result.response.json().catch(() => null)) as Record<
		string,
		unknown
	> | null
	if (result.response.ok && json) return { ok: true, body: json }
	return {
		ok: false,
		code: typeof json?.code === 'string' ? json.code : 'app_error',
		message:
			typeof json?.message === 'string'
				? json.message
				: `The App answered ${result.response.status}.`,
	}
}

export async function action({
	request,
}: ActionFunctionArgs): Promise<CustomerAppAdminResult> {
	const adminId = await requireUserWithPermission(
		request,
		CUSTOMER_APP_PERMISSION,
	)
	const form = await request.formData()
	const parsed = ActionSchema.safeParse(Object.fromEntries(form))
	if (!parsed.success) {
		return {
			ok: false,
			code: 'invalid_form',
			message: 'Check the form values.',
		}
	}
	const input = parsed.data
	const pass = (
		result: Awaited<ReturnType<typeof app>>,
	): CustomerAppAdminResult => (result.ok ? { ok: true } : result)

	switch (input._action) {
		case 'create': {
			const result = await app({
				intent: 'create',
				actorId: adminId,
				organizationId: input.organizationId,
			})
			if (!result.ok) return result
			return { ok: true, created: String(result.body.appId ?? '') }
		}
		case 'update': {
			const sha = (input.androidSha256 ?? '')
				.split(/[\s,]+/)
				.map((value) => value.trim())
				.filter(Boolean)
			return pass(
				await app({
					intent: 'update',
					appId: input.appId,
					displayName: input.displayName,
					iosBundleId: input.iosBundleId,
					androidPackage: input.androidPackage,
					marketingVersion: input.marketingVersion,
					iconBackground: input.iconBackground,
					publisher: input.publisher,
					appleTeamId: input.appleTeamId ? input.appleTeamId : null,
					androidSha256: sha,
					listingText: {
						subtitle: input.subtitle ?? '',
						description: input.description ?? '',
					},
					storeUrls: {
						app_store: input.appStoreUrl ? input.appStoreUrl : null,
						play_store: input.playStoreUrl ? input.playStoreUrl : null,
					},
				}),
			)
		}
		case 'delete':
			return pass(await app({ intent: 'delete', appId: input.appId }))
		case 'archive':
			return pass(
				await app({
					intent: 'archive',
					appId: input.appId,
					archived: input.archived === 'true',
				}),
			)
		case 'credential-apns':
			return pass(
				await app({
					intent: 'credential',
					appId: input.appId,
					kind: 'apns',
					actorId: adminId,
					payload: { key: input.key, keyId: input.keyId, teamId: input.teamId },
				}),
			)
		case 'credential-fcm':
			return pass(
				await app({
					intent: 'credential',
					appId: input.appId,
					kind: 'fcm',
					actorId: adminId,
					payload: input.serviceAccount,
				}),
			)
		case 'credential-remove':
			return pass(
				await app({
					intent: 'credential-remove',
					appId: input.appId,
					kind: input.kind,
				}),
			)
		case 'credential-check': {
			const result = await app({
				intent: 'credential-check',
				appId: input.appId,
				kind: input.kind,
			})
			if (!result.ok) return result
			return { ok: true, valid: result.body.valid === true }
		}
		case 'build':
			return pass(
				await app({
					intent: 'build',
					appId: input.appId,
					release: input.release,
					platforms: input.platform === 'both' ? undefined : [input.platform],
					actorId: adminId,
				}),
			)
		case 'release': {
			const apps = await db
				.select({ id: CustomerApp.id })
				.from(CustomerApp)
				.where(inArray(CustomerApp.status, ['draft', 'published']))
			if (apps.length === 0) {
				return {
					ok: false,
					code: 'no_apps',
					message: 'There are no apps to build.',
				}
			}
			const result = await app({
				intent: 'release',
				appIds: apps.map((row) => row.id),
				release: input.release,
				actorId: adminId,
			})
			if (!result.ok) return result
			return {
				ok: true,
				outcomes: result.body.outcomes as BuildOutcome[],
				summary: result.body.summary as ReturnType<typeof summarizeRelease>,
			}
		}
		case 'retry': {
			const result = await app({
				intent: 'retry',
				release: input.release,
				appIds: input.appId ? [input.appId] : undefined,
				actorId: adminId,
			})
			if (!result.ok) return result
			return {
				ok: true,
				outcomes: result.body.outcomes as BuildOutcome[],
				summary: result.body.summary as ReturnType<typeof summarizeRelease>,
			}
		}
		case 'refresh-health':
			return pass(await app({ intent: 'refresh-health', appId: input.appId }))
		case 'account': {
			const expiresAt = input.expiresOn
				? Date.parse(`${input.expiresOn}T00:00:00Z`)
				: NaN
			return pass(
				await app({
					intent: 'account',
					appId: input.appId,
					developerAccountExpiresAt: Number.isFinite(expiresAt)
						? expiresAt
						: null,
					termsAccepted: input.termsAccepted,
					paymentTermsAccepted: input.paymentTermsAccepted,
					accessOk: input.accessOk,
				}),
			)
		}
	}
}
