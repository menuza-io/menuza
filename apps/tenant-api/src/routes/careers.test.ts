import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	hiringApplications,
	hiringEvents,
	notificationOutbox,
} from '@repo/tenant-db'
import {
	createHiringHarness,
	LOC_1,
	LOC_2,
	ORG_A,
	ORG_B,
	seedApplication,
	type HiringHarness,
} from '../../tests/hiring-harness.ts'
import { resetJobPostingCache } from '../lib/job-posting-context.ts'
import { resetRateLimits } from '../lib/rate-limit.ts'
import { syncEnvFromProcess } from '../lib/secrets.ts'

vi.mock('@repo/database', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@repo/database')>()
	return {
		...actual,
		db: {
			select: () => {
				throw new Error('no control-plane database in this test')
			},
		},
	}
})

const POSTING = {
	id: 'post-line-cook',
	slug: 'line-cook',
	title: 'Line cook',
	positionName: 'Line cook',
	scopeIds: [LOC_1],
	questions: [
		{
			id: 'weekends',
			kind: 'yes_no',
			prompt: 'Can you work weekends?',
			category: 'availability',
			dealbreaker: true,
			requiredAnswer: 'yes',
		},
		{
			id: 'about',
			kind: 'open',
			prompt: 'About you',
			required: false,
			maxLength: 200,
		},
	],
}

type World = {
	/** slug -> organization the App knows. */
	organizations: Record<
		string,
		{ id: string; dataRegion: string; customDomain?: string | null }
	>
	/** `${orgId}|${slug}` -> posting, absent means 404. */
	postings: Record<string, typeof POSTING>
	postingStatus: number | null
	turnstile: { success: boolean; action?: string; hostname?: string }
	calls: string[]
}

function installWorld(): World {
	const world: World = {
		organizations: {
			acme: { id: ORG_A, dataRegion: 'us' },
			other: { id: ORG_B, dataRegion: 'us' },
			riyadh: { id: 'clw9x0a12000008l00staffk', dataRegion: 'ksa' },
		},
		postings: { [`${ORG_A}|line-cook`]: POSTING },
		postingStatus: null,
		turnstile: {
			success: true,
			action: 'careers-apply',
			hostname: 'acme.menuza.test',
		},
		calls: [],
	}
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input))
			world.calls.push(`${url.hostname}${url.pathname}`)
			if (url.hostname === 'challenges.cloudflare.com') {
				return Response.json(world.turnstile)
			}
			if (url.pathname === '/resources/sites') {
				const slug = url.searchParams.get('slug')
				const host = url.searchParams.get('host')
				const found = slug
					? world.organizations[slug]
					: Object.values(world.organizations).find(
							(o) => o.customDomain === host,
						)
				if (!found) return new Response('nope', { status: 404 })
				return Response.json({
					id: found.id,
					slug: slug ?? 'acme',
					customDomain: found.customDomain ?? null,
					dataRegion: found.dataRegion,
				})
			}
			if (url.pathname === '/resources/staffing/job-posting') {
				if (world.postingStatus) {
					return new Response('x', { status: world.postingStatus })
				}
				const orgId = url.searchParams.get('orgId')
				const slug = url.searchParams.get('slug')
				const posting = world.postings[`${orgId}|${slug}`]
				if (!posting) return new Response('nope', { status: 404 })
				return Response.json({ orgId, posting })
			}
			return new Response('unexpected', { status: 500 })
		}),
	)
	return world
}

const valid = {
	postingSlug: 'line-cook',
	firstName: 'Sara',
	lastName: 'Ali',
	email: 'Sara@Example.com',
	locale: 'en',
	answers: { weekends: 'no', about: 'Two years on the grill' },
	consent: true,
	consentVersion: '2026-10',
}

describe('POST /careers/apply', () => {
	let h: HiringHarness
	let world: World

	beforeEach(async () => {
		resetJobPostingCache()
		resetRateLimits()
		h = await createHiringHarness()
		world = installWorld()
		vi.stubEnv('APP_URL', 'https://app.test')
		vi.stubEnv('TURNSTILE_SECRET_KEY', '')
		vi.stubEnv('TURNSTILE_HOSTNAMES', '')
		vi.stubEnv('NODE_ENV', 'development')
		syncEnvFromProcess()
	})

	afterEach(async () => {
		vi.unstubAllGlobals()
		vi.unstubAllEnvs()
		syncEnvFromProcess()
		await h.cleanup()
	})

	const origin = (slug = 'acme') => `https://${slug}.menuza.test`
	async function rows(orgId = ORG_A) {
		return (await h.db(orgId)).select().from(hiringApplications)
	}
	// Each test uses its own origin so the origin allow-list cache cannot leak.
	let n = 0
	const fresh = () => `acme-${(n += 1)}`
	function useOrigin(slug: string, org = { id: ORG_A, dataRegion: 'us' }) {
		world.organizations[slug] = org
		world.postings[`${org.id}|line-cook`] = POSTING
		return origin(slug)
	}

	describe('a valid application', () => {
		it('is stored with server-side consent, snapshots, score and flags, and queues a manager event', async () => {
			const o = useOrigin(fresh())
			const reply = await h.careers('/apply', {
				origin: o,
				body: valid,
				headers: { 'cf-connecting-ip': '203.0.113.5' },
			})
			expect(reply.status).toBe(201)
			expect(reply.body).toEqual({ received: true })
			expect(reply.headers.get('cache-control')).toBe('private, no-store')

			const [row] = await rows()
			expect(row).toMatchObject({
				postingId: POSTING.id,
				postingSlug: 'line-cook',
				postingTitle: 'Line cook',
				scopeId: LOC_1,
				firstName: 'Sara',
				lastName: 'Ali',
				email: 'sara@example.com',
				phone: null,
				stage: 'new',
				source: 'careers_page',
				consentVersion: '2026-10',
				screenerScore: 0,
				screenerFlags: ['weekends'],
				hiredStaffId: null,
			})
			expect(Math.abs(row!.consentAt - Date.now())).toBeLessThan(10_000)
			expect(row!.answers).toEqual([
				expect.objectContaining({
					id: 'weekends',
					answer: 'no',
					requiredAnswer: 'yes',
					dealbreaker: true,
					prompt: 'Can you work weekends?',
				}),
				{
					id: 'about',
					kind: 'open',
					prompt: 'About you',
					answer: 'Two years on the grill',
				},
			])
			// The address is kept only as a keyed hash.
			expect(row!.ipHash).toMatch(/^[a-f0-9]{64}$/)
			expect(JSON.stringify(row)).not.toContain('203.0.113.5')
			expect(row!.emailHash).toMatch(/^[a-f0-9]{64}$/)
			expect(row!.emailHash).not.toContain('sara')

			const events = await (await h.db()).select().from(hiringEvents)
			expect(events).toEqual([
				expect.objectContaining({
					kind: 'applied',
					actorId: null,
					toStage: 'new',
				}),
			])
			const [outbox] = await (await h.db()).select().from(notificationOutbox)
			expect(outbox).toMatchObject({
				kind: 'manager.new_applicant',
				scopeId: LOC_1,
				staffId: 'system',
				status: 'pending',
				dedupeKey: `manager.new_applicant:${row!.id}`,
			})
			// Nothing about the person goes into the queued event.
			expect(JSON.stringify(outbox)).not.toMatch(/Sara|Ali|sara@/)
		})

		it('accepts a phone-only applicant typed with spaces and a 00 prefix', async () => {
			const o = useOrigin(fresh())
			const reply = await h.careers('/apply', {
				origin: o,
				body: { ...valid, email: undefined, phone: '00966 51 234 5678' },
			})
			expect(reply.status).toBe(201)
			const [row] = await rows()
			expect(row).toMatchObject({ email: null, phone: '+966512345678' })
			expect(row!.phoneHash).toBeTruthy()
		})

		it('never echoes a score, a flag or a stage back to the applicant', async () => {
			const o = useOrigin(fresh())
			const reply = await h.careers('/apply', { origin: o, body: valid })
			expect(reply.raw).toBe('{"received":true}')
		})

		it('works for a custom domain origin', async () => {
			world.organizations['x'] = {
				id: ORG_A,
				dataRegion: 'us',
				customDomain: 'jobs.acme-kitchen.com',
			}
			world.postings[`${ORG_A}|line-cook`] = POSTING
			const reply = await h.careers('/apply', {
				origin: 'https://jobs.acme-kitchen.com',
				body: { ...valid, host: 'jobs.acme-kitchen.com' },
			})
			expect(reply.status).toBe(201)
		})

		it('records where the person came from, from a fixed list', async () => {
			const o = useOrigin(fresh())
			await h.careers('/apply', { origin: o, body: { ...valid, source: 'qr' } })
			expect((await rows())[0]?.source).toBe('qr')
			const reply = await h.careers('/apply', {
				origin: o,
				body: { ...valid, email: 'b@example.com', source: 'newsletter' },
			})
			expect(reply.status).toBe(400)
		})
	})

	describe('which organization it is for', () => {
		it('comes from the Origin, never from a client-supplied id', async () => {
			const o = useOrigin(fresh())
			for (const extra of [
				{ orgId: ORG_B },
				{ organizationId: ORG_B },
				{ stage: 'hired' },
				{ hiredStaffId: 'x' },
				{ screenerScore: 100 },
			]) {
				const reply = await h.careers('/apply', {
					origin: o,
					body: { ...valid, ...extra },
				})
				expect(reply.status, JSON.stringify(extra)).toBe(400)
			}
			expect(await rows(ORG_A)).toHaveLength(0)
			expect(await rows(ORG_B)).toHaveLength(0)
		})

		it('ignores an orgId in the query string', async () => {
			const o = useOrigin(fresh())
			const reply = await h.careers(`/apply?orgId=${ORG_B}`, {
				origin: o,
				body: valid,
			})
			expect(reply.status).toBe(201)
			expect(await rows(ORG_A)).toHaveLength(1)
			expect(await rows(ORG_B)).toHaveLength(0)
		})

		it('refuses a body slug that disagrees with the Origin', async () => {
			const a = useOrigin(fresh())
			world.organizations['rival'] = { id: ORG_B, dataRegion: 'us' }
			world.postings[`${ORG_B}|line-cook`] = POSTING
			const reply = await h.careers('/apply', {
				origin: a,
				body: { ...valid, slug: 'rival' },
			})
			expect(reply.status).toBe(404)
			expect(await rows(ORG_B)).toHaveLength(0)
			expect(await rows(ORG_A)).toHaveLength(0)
		})

		it('refuses an Origin that names an organization with no such site', async () => {
			const reply = await h.careers('/apply', {
				origin: 'https://ghost.menuza.test',
				body: valid,
			})
			expect(reply.status).toBe(404)
		})

		it('refuses a request with no Origin, even with a slug in the body', async () => {
			useOrigin('acme')
			const reply = await h.careers('/apply', {
				origin: null,
				body: { ...valid, slug: 'acme' },
			})
			expect(reply.status).toBe(404)
			expect(await rows()).toHaveLength(0)
		})

		it("refuses the platform's own app origin and look-alike hosts", async () => {
			useOrigin('acme')
			for (const o of [
				'https://app.menuza.test',
				'https://menuza.test',
				'https://acme.menuza.test.evil.com',
				'null',
				'not a url',
				'ftp://acme.menuza.test',
			]) {
				const reply = await h.careers('/apply', {
					origin: o,
					body: { ...valid, slug: 'acme' },
				})
				expect(reply.status, o).toBe(404)
			}
			expect(await rows()).toHaveLength(0)
		})

		it('only honors a body slug for a local development origin outside production', async () => {
			useOrigin('acme')
			const dev = await h.careers('/apply', {
				origin: 'http://localhost:3008',
				body: { ...valid, slug: 'acme' },
			})
			expect(dev.status).toBe(201)

			vi.stubEnv('NODE_ENV', 'production')
			syncEnvFromProcess()
			const prod = await h.careers('/apply', {
				origin: 'http://localhost:3008',
				body: { ...valid, email: 'other@example.com', slug: 'acme' },
			})
			expect(prod.status).toBe(404)
			expect(await rows()).toHaveLength(1)
		})

		it('refuses an organization that belongs to another region', async () => {
			const o = useOrigin(fresh(), { id: ORG_A, dataRegion: 'ksa' })
			const reply = await h.careers('/apply', { origin: o, body: valid })
			expect(reply.status).toBe(404)
			expect(await rows()).toHaveLength(0)
		})
	})

	describe('abuse', () => {
		it('answers a filled honeypot like a success and stores nothing', async () => {
			const o = useOrigin(fresh())
			const reply = await h.careers('/apply', {
				origin: o,
				body: { ...valid, website: 'https://spam.example' },
			})
			expect(reply.status).toBe(201)
			expect(reply.body).toEqual({ received: true })
			expect(await rows()).toHaveLength(0)
			expect(world.calls.filter((c) => c.includes('job-posting'))).toHaveLength(
				0,
			)
		})

		it('requires a valid challenge when one is configured', async () => {
			vi.stubEnv('TURNSTILE_SECRET_KEY', 'secret-key')
			vi.stubEnv('TURNSTILE_HOSTNAMES', 'acme.menuza.test')
			syncEnvFromProcess()
			const o = useOrigin('acme')
			const missing = await h.careers('/apply', { origin: o, body: valid })
			expect(missing.status).toBe(403)
			expect(missing.body.error).toBe('verification_failed')

			world.turnstile = { success: false }
			const failed = await h.careers('/apply', {
				origin: o,
				body: { ...valid, turnstileToken: 'bad' },
			})
			expect(failed.status).toBe(403)

			world.turnstile = {
				success: true,
				action: 'website-form',
				hostname: 'acme.menuza.test',
			}
			const wrongAction = await h.careers('/apply', {
				origin: o,
				body: { ...valid, turnstileToken: 'token' },
			})
			expect(wrongAction.status).toBe(403)

			world.turnstile = {
				success: true,
				action: 'careers-apply',
				hostname: 'evil.example',
			}
			const wrongHost = await h.careers('/apply', {
				origin: o,
				body: { ...valid, turnstileToken: 'token' },
			})
			expect(wrongHost.status).toBe(403)
			expect(await rows()).toHaveLength(0)

			world.turnstile = {
				success: true,
				action: 'careers-apply',
				hostname: 'acme.menuza.test',
			}
			const good = await h.careers('/apply', {
				origin: o,
				body: { ...valid, turnstileToken: 'token' },
			})
			expect(good.status).toBe(201)
		})

		it('does not call the control plane for a request that fails validation or the challenge', async () => {
			vi.stubEnv('TURNSTILE_SECRET_KEY', 'secret-key')
			syncEnvFromProcess()
			const o = useOrigin('acme')
			await h.careers('/apply', {
				origin: o,
				body: { ...valid, consent: false },
			})
			await h.careers('/apply', { origin: o, body: valid })
			expect(world.calls.some((c) => c.includes('job-posting'))).toBe(false)
		})

		it('limits applications per address per hour, durably, without blocking others', async () => {
			const o = useOrigin(fresh())
			const ip = { 'cf-connecting-ip': '198.51.100.7' }
			for (let i = 0; i < 5; i++) {
				const reply = await h.careers('/apply', {
					origin: o,
					headers: ip,
					body: { ...valid, email: `person${i}@example.com` },
				})
				expect(reply.status, `application ${i}`).toBe(201)
			}
			const sixth = await h.careers('/apply', {
				origin: o,
				headers: ip,
				body: { ...valid, email: 'person6@example.com' },
			})
			expect(sixth.status).toBe(429)
			expect(sixth.body).toEqual({ error: 'rate_limit_exceeded' })
			expect(await rows()).toHaveLength(5)

			const elsewhere = await h.careers('/apply', {
				origin: o,
				headers: { 'cf-connecting-ip': '198.51.100.8' },
				body: { ...valid, email: 'person7@example.com' },
			})
			expect(elsewhere.status).toBe(201)
		})

		it('caps what one organization accepts per hour', async () => {
			const o = useOrigin(fresh())
			const d = await h.db()
			for (let i = 0; i < 60; i++) {
				await seedApplication(d, { createdAt: Date.now() - 1000 })
			}
			const reply = await h.careers('/apply', { origin: o, body: valid })
			expect(reply.status).toBe(429)
			// Old applications do not count against it.
			await d
				.update(hiringApplications)
				.set({ createdAt: Date.now() - 2 * 3_600_000 })
			const later = await h.careers('/apply', { origin: o, body: valid })
			expect(later.status).toBe(201)
		})

		it('rejects an oversized body before parsing it', async () => {
			const o = useOrigin(fresh())
			const reply = await h.careers('/apply', {
				origin: o,
				rawBody: JSON.stringify({
					...valid,
					answers: { about: 'x'.repeat(40_000) },
				}),
			})
			expect(reply.status).toBe(413)
			expect(await rows()).toHaveLength(0)
		})

		it('rejects malformed JSON and non-object bodies', async () => {
			const o = useOrigin(fresh())
			for (const rawBody of ['{', 'null', '[]', '"x"', '']) {
				const reply = await h.careers('/apply', { origin: o, rawBody })
				expect(reply.status, rawBody).toBe(400)
			}
		})

		it('does not let markup or script in a name through, and keeps free text as plain text', async () => {
			const o = useOrigin(fresh())
			const bad = await h.careers('/apply', {
				origin: o,
				body: { ...valid, firstName: '<img src=x onerror=alert(1)>' },
			})
			expect(bad.status).toBe(400)
			const ok = await h.careers('/apply', {
				origin: o,
				body: {
					...valid,
					answers: {
						weekends: 'yes',
						about: "<b>Hello</b>\u0000 '; DROP TABLE hiring_applications;--",
					},
				},
			})
			expect(ok.status).toBe(201)
			const [row] = await rows()
			const about = (
				row!.answers as Array<{ id: string; answer: string }>
			).find((a) => a.id === 'about')
			expect(about?.answer).toBe(
				"<b>Hello</b> '; DROP TABLE hiring_applications;--",
			)
			expect(await rows()).toHaveLength(1)
		})
	})

	describe('validation', () => {
		it.each([
			['consent missing', { consent: undefined }],
			['consent false', { consent: false }],
			['consent as text', { consent: 'true' }],
			['unknown consent version', { consentVersion: '1999-01' }],
			['no way to reach them', { email: undefined }],
			['bad email', { email: 'not-an-email' }],
			[
				'national phone with no country code',
				{ email: undefined, phone: '0512345678' },
			],
			['no last name', { lastName: '' }],
			['name too long', { firstName: 'a'.repeat(81) }],
			['bad locale', { locale: 'fr' }],
			['posting slug with a path', { postingSlug: '../x' }],
			['posting slug with capitals', { postingSlug: 'Line-Cook' }],
			[
				'too many answers',
				{
					answers: Object.fromEntries(
						Array.from({ length: 21 }, (_, i) => [`q${i}`, 'yes']),
					),
				},
			],
			['answer key with symbols', { answers: { 'a b': 'yes' } }],
		])('refuses %s', async (_label, patch) => {
			const o = useOrigin(fresh())
			const reply = await h.careers('/apply', {
				origin: o,
				body: { ...valid, ...patch },
			})
			expect(reply.status).toBe(400)
			expect(await rows()).toHaveLength(0)
		})

		it('does not echo rejected values back', async () => {
			const o = useOrigin(fresh())
			const reply = await h.careers('/apply', {
				origin: o,
				body: {
					...valid,
					locale: 'SECRET-LOCALE',
					consentVersion: 'SECRET-VERSION',
				},
			})
			expect(reply.raw).not.toContain('SECRET')
		})

		it("checks answers against the posting's own questions", async () => {
			const o = useOrigin(fresh())
			const missing = await h.careers('/apply', {
				origin: o,
				body: { ...valid, answers: {} },
			})
			expect(missing.status).toBe(400)
			expect(missing.body).toEqual({
				error: 'invalid_answers',
				problems: [{ questionId: 'weekends', code: 'missing' }],
			})
			const unknown = await h.careers('/apply', {
				origin: o,
				body: { ...valid, answers: { weekends: 'yes', admin: 'yes' } },
			})
			expect(unknown.body.problems).toEqual([
				{ questionId: 'admin', code: 'unknown' },
			])
			const invalid = await h.careers('/apply', {
				origin: o,
				body: { ...valid, answers: { weekends: 'perhaps' } },
			})
			expect(invalid.body.problems).toEqual([
				{ questionId: 'weekends', code: 'invalid' },
			])
			const long = await h.careers('/apply', {
				origin: o,
				body: {
					...valid,
					answers: { weekends: 'yes', about: 'x'.repeat(201) },
				},
			})
			expect(long.body.problems).toEqual([
				{ questionId: 'about', code: 'too_long' },
			])
			expect(await rows()).toHaveLength(0)
		})

		it('never lets a prototype key become an answer or pollute anything', async () => {
			const o = useOrigin(fresh())
			const reply = await h.careers('/apply', {
				origin: o,
				rawBody: JSON.stringify(valid).replace(
					'"answers":{',
					'"answers":{"__proto__":{"polluted":true},"constructor":"yes",',
				),
			})
			// `constructor` is not a question the posting asks.
			expect(reply.status).toBe(400)
			expect(({} as Record<string, unknown>).polluted).toBeUndefined()
			expect(await rows()).toHaveLength(0)
			const quiet = await h.careers('/apply', {
				origin: o,
				rawBody: JSON.stringify(valid).replace(
					'"answers":{',
					'"answers":{"__proto__":"yes",',
				),
			})
			expect(quiet.status).toBe(201)
			const [row] = await rows()
			expect((row!.answers as Array<{ id: string }>).map((a) => a.id)).toEqual([
				'weekends',
				'about',
			])
		})
	})

	describe('the posting', () => {
		it('is looked up in the control plane for this organization, not trusted from the client', async () => {
			const o = useOrigin(fresh())
			await h.careers('/apply', {
				origin: o,
				body: { ...valid, title: 'CEO', positionName: 'CEO' },
			})
			expect(await rows()).toHaveLength(0)
			await h.careers('/apply', { origin: o, body: valid })
			expect((await rows())[0]?.postingTitle).toBe('Line cook')
		})

		it('answers 404 for a posting that is not live, and stores nothing', async () => {
			const o = useOrigin(fresh())
			const reply = await h.careers('/apply', {
				origin: o,
				body: { ...valid, postingSlug: 'closed-job' },
			})
			expect(reply.status).toBe(404)
			expect(reply.body.error).toBe('posting_not_found')
			expect(await rows()).toHaveLength(0)
		})

		it("does not apply to another organization's posting", async () => {
			const o = useOrigin(fresh())
			world.postings[`${ORG_B}|secret-job`] = { ...POSTING, slug: 'secret-job' }
			const reply = await h.careers('/apply', {
				origin: o,
				body: { ...valid, postingSlug: 'secret-job' },
			})
			expect(reply.status).toBe(404)
		})

		it("takes the scope from the posting, and refuses one it does not list (another scope's applicants are not reachable)", async () => {
			const o = useOrigin(fresh())
			const named = await h.careers('/apply', {
				origin: o,
				body: { ...valid, scopeId: LOC_2 },
			})
			expect(named.status).toBe(400)
			expect(await rows()).toHaveLength(0)

			// A posting at another scope lands at that scope, not at the
			// first one.
			world.postings[`${ORG_A}|host-job`] = {
				...POSTING,
				id: 'post-host',
				slug: 'host-job',
				scopeIds: [LOC_2],
			}
			await h.careers('/apply', {
				origin: o,
				body: { ...valid, postingSlug: 'host-job' },
			})
			await h.careers('/apply', { origin: o, body: valid })
			const stored = await rows()
			expect(
				stored.map((row) => [row.postingSlug, row.scopeId]).sort(),
			).toEqual([
				['host-job', LOC_2],
				['line-cook', LOC_1],
			])
		})

		it("files an application under the first scope the applicant chose, in the posting's order", async () => {
			const o = useOrigin(fresh())
			world.postings[`${ORG_A}|three-places`] = {
				...POSTING,
				id: 'post-three',
				slug: 'three-places',
				scopeIds: [LOC_1, LOC_2, 'loc-3'],
			}
			const body = { ...valid, postingSlug: 'three-places' }

			// One that is not the posting's makes the whole choice invalid.
			const bad = await h.careers('/apply', {
				origin: o,
				body: { ...body, scopeIds: [LOC_2, 'not-listed'] },
			})
			expect(bad.body).toEqual({ error: 'invalid_scope' })
			expect(await rows()).toHaveLength(0)

			const ok = await h.careers('/apply', {
				origin: o,
				body: { ...body, scopeIds: ['loc-3', LOC_2] },
			})
			expect(ok.status).toBe(201)
			const [row] = await rows()
			// The first chosen scope in the posting's own order is the one kept.
			expect(row?.scopeId).toBe(LOC_2)
			// Every scope the person named is stored, the primary first.
			expect(row?.interestedScopeIds).toEqual([LOC_2, 'loc-3'])
			// Each chosen scope's managers are told, once.
			const alerts = await (await h.db()).select().from(notificationOutbox)
			expect(alerts.map((a) => a.scopeId).sort()).toEqual([LOC_2, 'loc-3'])
			expect(new Set(alerts.map((a) => a.dedupeKey)).size).toBe(2)
		})

		it("makes the applicant pick among a posting's several scopes, and checks it", async () => {
			const o = useOrigin(fresh())
			world.postings[`${ORG_A}|two-places`] = {
				...POSTING,
				id: 'post-two',
				slug: 'two-places',
				scopeIds: [LOC_1, LOC_2],
			}
			const body = { ...valid, postingSlug: 'two-places' }

			// Open at two places: no choice is not enough.
			const none = await h.careers('/apply', { origin: o, body })
			expect(none.status).toBe(400)
			expect(none.body).toEqual({ error: 'invalid_scope' })
			// A scope the posting does not list is refused, even a real one.
			const foreign = await h.careers('/apply', {
				origin: o,
				body: { ...body, scopeId: 'not-a-listed-scope' },
			})
			expect(foreign.status).toBe(400)
			expect(await rows()).toHaveLength(0)

			const picked = await h.careers('/apply', {
				origin: o,
				body: { ...body, scopeId: LOC_2 },
			})
			expect(picked.status).toBe(201)
			const [row] = await rows()
			expect(row?.scopeId).toBe(LOC_2)
			const [outbox] = await (await h.db()).select().from(notificationOutbox)
			expect(outbox?.scopeId).toBe(LOC_2)
		})

		it('asks the applicant to try again when the control plane cannot be reached', async () => {
			const o = useOrigin(fresh())
			world.postingStatus = 503
			const reply = await h.careers('/apply', { origin: o, body: valid })
			expect(reply.status).toBe(503)
			expect(reply.body.error).toBe('unavailable')
			expect(await rows()).toHaveLength(0)
		})

		it('treats a feature that is off like a posting that does not exist', async () => {
			const o = useOrigin(fresh())
			world.postingStatus = 404
			const reply = await h.careers('/apply', { origin: o, body: valid })
			expect(reply.status).toBe(404)
		})
	})

	describe('repeat applications', () => {
		it('look exactly like a first one and create no second record', async () => {
			const o = useOrigin(fresh())
			const first = await h.careers('/apply', { origin: o, body: valid })
			const again = await h.careers('/apply', {
				origin: o,
				body: { ...valid, email: ' SARA@example.COM ', firstName: 'Sarah' },
			})
			expect(again.status).toBe(first.status)
			expect(again.raw).toBe(first.raw)
			expect(await rows()).toHaveLength(1)
			expect(
				await (await h.db()).select().from(notificationOutbox),
			).toHaveLength(1)
		})

		it('are matched by phone as well as email', async () => {
			const o = useOrigin(fresh())
			await h.careers('/apply', {
				origin: o,
				body: { ...valid, phone: '+14155550123' },
			})
			await h.careers('/apply', {
				origin: o,
				body: {
					...valid,
					email: 'new@example.com',
					phone: '+1 (415) 555-0123',
				},
			})
			expect(await rows()).toHaveLength(1)
		})

		it('allow the same person to apply to a different job', async () => {
			const o = useOrigin(fresh())
			world.postings[`${ORG_A}|server`] = {
				...POSTING,
				id: 'post-server',
				slug: 'server',
				title: 'Server',
			}
			await h.careers('/apply', { origin: o, body: valid })
			const reply = await h.careers('/apply', {
				origin: o,
				body: { ...valid, postingSlug: 'server' },
			})
			expect(reply.status).toBe(201)
			expect(await rows()).toHaveLength(2)
		})

		it('allow a declined applicant to apply again, and do not allow it while still in the pipeline', async () => {
			const o = useOrigin(fresh())
			await h.careers('/apply', { origin: o, body: valid })
			const d = await h.db()
			await d.update(hiringApplications).set({ stage: 'declined' })
			await h.careers('/apply', { origin: o, body: valid })
			expect(await rows()).toHaveLength(2)
			await h.careers('/apply', { origin: o, body: valid })
			expect(await rows()).toHaveLength(2)
		})

		it('keep one record when two submissions race', async () => {
			const o = useOrigin(fresh())
			const results = await Promise.all(
				Array.from({ length: 4 }, () =>
					h.careers('/apply', { origin: o, body: valid }),
				),
			)
			expect(results.every((r) => r.status === 201)).toBe(true)
			expect(await rows()).toHaveLength(1)
		})

		it('do not match across organizations', async () => {
			const a = useOrigin(fresh())
			await h.careers('/apply', { origin: a, body: valid })
			const b = useOrigin(fresh(), { id: ORG_B, dataRegion: 'us' })
			await h.careers('/apply', { origin: b, body: valid })
			expect(await rows(ORG_A)).toHaveLength(1)
			expect(await rows(ORG_B)).toHaveLength(1)
		})
	})

	describe('consent', () => {
		it("is recorded with the version and the server's clock, ignoring any time the browser sends", async () => {
			const o = useOrigin(fresh())
			const reply = await h.careers('/apply', {
				origin: o,
				body: { ...valid, consentAt: 5 },
			})
			expect(reply.status).toBe(400)
			await h.careers('/apply', { origin: o, body: valid })
			const [row] = await rows()
			expect(row!.consentVersion).toBe('2026-10')
			expect(row!.consentAt).toBeGreaterThan(Date.now() - 10_000)
		})
	})
})
