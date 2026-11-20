/**
 * #194, Admin: publishing a numbered agreement version and listing the
 * organizations that have not accepted it (who has and has not accepted).
 */
import { randomUUID } from 'node:crypto'
import {
	authSessionStorage,
	getSessionExpirationDate,
	sessionKey,
} from '@repo/auth'
import {
	db,
	eq,
	LegalAcceptance,
	LegalAgreement,
	Organization,
	Role,
	Session,
	User,
	UserOrganization,
	_RoleToUser,
} from '@repo/database'
import { afterEach, describe, expect, it } from 'vitest'
import {
	action,
	listOrganizationsMissing,
	loadAgreementOverview,
	loader,
	publishAgreementVersion,
} from './legal-agreements.server.ts'

const orgIds: string[] = []
afterEach(async () => {
	for (const id of orgIds.splice(0)) {
		await db.delete(Organization).where(eq(Organization.id, id))
	}
})

async function makeUser(label: string) {
	const id = randomUUID()
	const [user] = await db
		.insert(User)
		.values({
			username: `${label}-${id.slice(0, 8)}`,
			email: `${label}-${id}@example.com`,
			name: `${label} person`,
		})
		.returning()
	return user!
}

async function makeOrg(name: string) {
	const owner = await makeUser(`owner-${name}`)
	const [organization] = await db
		.insert(Organization)
		.values({
			name,
			slug: `${name}-${randomUUID().slice(0, 8)}`.toLowerCase(),
		})
		.returning()
	orgIds.push(organization!.id)
	await db.insert(UserOrganization).values({
		userId: owner.id,
		organizationId: organization!.id,
		organizationRoleId: 'org_role_admin',
	})
	return { organization: organization!, owner }
}

async function adminCookie() {
	const admin = await makeUser('platform-admin')
	await db
		.insert(Role)
		.values({ name: 'admin', description: 'admin role' })
		.onConflictDoNothing()
	const role = await db.query.Role.findFirst({ where: eq(Role.name, 'admin') })
	await db.insert(_RoleToUser).values({ A: role!.id, B: admin.id })
	const [session] = await db
		.insert(Session)
		.values({ userId: admin.id, expirationDate: getSessionExpirationDate() })
		.returning()
	const authSession = await authSessionStorage.getSession()
	authSession.set(sessionKey, session!.id)
	return authSessionStorage.commitSession(authSession)
}

async function accept(
	organizationId: string,
	userId: string,
	key: string,
	version: number,
) {
	await db.insert(LegalAcceptance).values({
		agreementKey: key,
		version,
		organizationId,
		userId,
		source: 'dialog',
	})
}

describe('Admin legal agreements (#194)', () => {
	it('publishes the next numbered version, with a required-by date', async () => {
		const admin = await makeUser('publisher')
		const requiredBy = '2027-01-31'
		const before = (await loadAgreementOverview()).find(
			(row) => row.key === 'payments',
		)!
		const published = await publishAgreementVersion(admin.id, {
			_action: 'publish',
			key: 'payments',
			titleEn: 'Payment Terms',
			titleAr: 'شروط الدفع',
			summaryEn: 'New fees',
			url: '/tos#payments',
			requiredBy,
		})
		expect(published).toEqual({ key: 'payments', version: before.version + 1 })
		const [row] = await db
			.select()
			.from(LegalAgreement)
			.where(eq(LegalAgreement.key, 'payments'))
			.orderBy(LegalAgreement.version)
		expect(row).toBeTruthy()
		const overview = (await loadAgreementOverview()).find(
			(r) => r.key === 'payments',
		)!
		expect(overview.version).toBe(before.version + 1)
		expect(overview.requiredBy).toBe(new Date(requiredBy).toISOString())
		// A module agreement keeps its scope across versions.
		expect(overview.scope).toBe('module')
		// Both languages are stored.
		const stored = await db
			.select({ title: LegalAgreement.title })
			.from(LegalAgreement)
			.where(eq(LegalAgreement.version, published.version))
		expect(
			JSON.parse(stored.find((s) => s.title.includes('Payment Terms'))!.title),
		).toEqual({
			en: 'Payment Terms',
			ar: 'شروط الدفع',
		})
	})

	it('lists the organizations that have not accepted a version, with their owners', async () => {
		const accepted = await makeOrg('accepted')
		const missing = await makeOrg('missing')
		const older = await makeOrg('older')
		const overview = (await loadAgreementOverview()).find(
			(row) => row.key === 'terms',
		)!
		const latest = overview.version
		await accept(accepted.organization.id, accepted.owner.id, 'terms', latest)
		// An acceptance of an older version does not count for the newest.
		if (latest > 1) {
			await accept(older.organization.id, older.owner.id, 'terms', latest - 1)
		}

		const result = await listOrganizationsMissing({
			key: 'terms',
			version: latest,
		})
		expect(result).not.toBeNull()
		const ids = result!.organizations.map((org) => org.id)
		expect(ids).toContain(missing.organization.id)
		expect(ids).not.toContain(accepted.organization.id)
		const row = result!.organizations.find(
			(org) => org.id === missing.organization.id,
		)!
		expect(row.owners).toEqual([missing.owner.name])
		expect(result!.agreement).toMatchObject({ key: 'terms', version: latest })

		const counts = (await loadAgreementOverview()).find(
			(r) => r.key === 'terms',
		)!
		expect(counts.acceptedCount).toBeGreaterThanOrEqual(1)
		expect(counts.organizationCount).toBeGreaterThanOrEqual(3)
	})

	it('says whether the required-by date has passed', async () => {
		const admin = await makeUser('publisher')
		const { version } = await publishAgreementVersion(admin.id, {
			_action: 'publish',
			key: 'dpa',
			titleEn: 'DPA',
			url: '/privacy#data-processing',
			requiredBy: '2020-01-01',
		})
		const result = await listOrganizationsMissing({ key: 'dpa', version })
		expect(result!.agreement.overdue).toBe(true)
		expect(await listOrganizationsMissing({ key: 'ghost' })).toBeNull()
	})

	it('only an admin can open or publish', async () => {
		const anonymous = new Request('http://localhost:3005/legal-agreements')
		await expect(
			loader({ request: anonymous, params: {}, context: {} } as never),
		).rejects.toBeTruthy()
		const cookie = await adminCookie()
		const data = await loader({
			request: new Request('http://localhost:3005/legal-agreements', {
				headers: { Cookie: cookie },
			}),
			params: {},
			context: {},
		} as never)
		expect(data.overview.map((row) => row.key).sort()).toEqual(
			expect.arrayContaining([
				'dpa',
				'payments',
				'privacy',
				'terms',
				'text_marketing',
			]),
		)
		const refused = (await action({
			request: new Request('http://localhost:3005/legal-agreements', {
				method: 'POST',
				headers: { Cookie: cookie },
				body: new URLSearchParams({
					_action: 'publish',
					key: 'terms',
					titleEn: '',
					url: 'javascript:alert(1)',
				}),
			}),
			params: {},
			context: {},
		} as never)) as Response
		expect(refused.status).toBe(400)
	})
})
