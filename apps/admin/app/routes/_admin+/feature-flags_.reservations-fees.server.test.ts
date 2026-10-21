import { randomUUID } from 'node:crypto'
import {
	authSessionStorage,
	getSessionExpirationDate,
	sessionKey,
} from '@repo/auth'
import {
	and,
	ConfigFlag,
	db,
	eq,
	Organization,
	Role,
	Session,
	User,
	_RoleToUser,
} from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import { action, loader } from './feature-flags_.reservations-fees.server.ts'
import {
	formatBpAsPercent,
	PLATFORM_FEE_FLAG_KEY,
	PlatformFeeBpSchema,
} from './feature-flags_.reservations-fees.shared.ts'

describe('PlatformFeeBpSchema', () => {
	it('accepts integers 0..10000', () => {
		for (const ok of ['0', '250', '10000', ' 42 ']) {
			expect(PlatformFeeBpSchema.safeParse(ok).success).toBe(true)
		}
	})
	it('refuses fractions, negatives, too large and non-numeric text', () => {
		for (const bad of ['12.5', '-1', '10001', 'abc', '', '1e3', undefined]) {
			const result = PlatformFeeBpSchema.safeParse(bad)
			expect(result.success).toBe(false)
			if (!result.success && typeof bad === 'string' && bad) {
				expect(JSON.stringify(result.error.issues)).not.toContain(bad)
			}
		}
	})
})

describe('formatBpAsPercent', () => {
	it('shows two decimals', () => {
		expect(formatBpAsPercent(250)).toBe('2.50%')
		expect(formatBpAsPercent(0)).toBe('0.00%')
		expect(formatBpAsPercent(10000)).toBe('100.00%')
	})
})

async function setup() {
	const id = randomUUID()
	const [user] = await db
		.insert(User)
		.values({ username: id, email: `${id}@example.com` })
		.returning()
	await db
		.insert(Role)
		.values({ name: 'admin', description: 'admin role' })
		.onConflictDoNothing()
	const role = await db.query.Role.findFirst({ where: eq(Role.name, 'admin') })
	await db.insert(_RoleToUser).values({ A: role!.id, B: user!.id })
	const [session] = await db
		.insert(Session)
		.values({ userId: user!.id, expirationDate: getSessionExpirationDate() })
		.returning()
	const authSession = await authSessionStorage.getSession()
	authSession.set(sessionKey, session!.id)
	const cookie = await authSessionStorage.commitSession(authSession)
	const [org] = await db
		.insert(Organization)
		.values({ name: `Fee Org ${id.slice(0, 6)}`, slug: `fee-${id}` })
		.returning()

	const url = 'http://localhost:3004/feature-flags/reservations-fees'
	const args = (init?: RequestInit) =>
		({
			request: new Request(url, { headers: { Cookie: cookie }, ...init }),
			params: {},
			context: new RouterContextProvider(),
			url: new URL(url),
			pattern: '/feature-flags/reservations-fees',
		}) as never
	const post = (body: Record<string, string>) =>
		action(args({ method: 'POST', body: new URLSearchParams(body) }))
	return { org: org!, post, load: () => loader(args()) }
}

async function systemRows() {
	return db
		.select()
		.from(ConfigFlag)
		.where(
			and(
				eq(ConfigFlag.key, PLATFORM_FEE_FLAG_KEY),
				eq(ConfigFlag.level, 'system'),
			),
		)
}

describe('reservations fees admin action', () => {
	beforeEach(async () => {
		await db.delete(ConfigFlag).where(eq(ConfigFlag.key, PLATFORM_FEE_FLAG_KEY))
	})

	it('refuses bad input, writes nothing and does not echo it', async () => {
		const { post } = await setup()
		for (const bp of ['12.5', '-1', '10001', 'lots']) {
			const result = await post({ _action: 'set-system', bp })
			expect(result.ok).toBe(false)
			expect(JSON.stringify(result)).not.toContain(bp)
		}
		expect(await systemRows()).toHaveLength(0)
	})

	it('saves the system default as a JSON integer, including 0 and 10000', async () => {
		const { post, load } = await setup()
		for (const bp of [250, 0, 10000]) {
			expect(await post({ _action: 'set-system', bp: String(bp) })).toEqual({
				ok: true,
			})
			const rows = await systemRows()
			expect(rows).toHaveLength(1)
			expect(rows[0]!.value).toBe(bp)
			expect((await load()).systemBp).toBe(bp)
		}
	})

	it('adds, replaces and removes an organization override', async () => {
		const { post, load, org } = await setup()
		expect(
			await post({
				_action: 'set-override',
				organization: org.slug,
				bp: '100',
			}),
		).toEqual({ ok: true })
		await post({ _action: 'set-override', organization: org.name, bp: '0' })
		let data = await load()
		const mine = data.overrides.filter((o) => o.slug === org.slug)
		expect(mine).toEqual([expect.objectContaining({ bp: 0 })])

		const bad = await post({
			_action: 'set-override',
			organization: 'no-such-org-xyz',
			bp: '5',
		})
		expect(bad.ok).toBe(false)

		await post({ _action: 'remove-override', id: mine[0]!.id })
		data = await load()
		expect(data.overrides.filter((o) => o.slug === org.slug)).toHaveLength(0)
	})
})
