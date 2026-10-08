import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import { sendSms } from '@repo/sms'
import {
	customers,
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	voiceCallRequests,
	voiceCalls,
	voiceLineVerifications,
	voiceLinkHandoffs,
	voiceRecordingDeletions,
	voiceSmsSends,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	findActiveOrganizationById,
	resolveOrganizationForBrowserAuth,
} from '../lib/origin.ts'
import { sendTenantEmail } from '../lib/tenant-email.ts'
import {
	HANDOFF_GRACE_DAYS,
	LINK_MESSAGE_MAX_CHARS,
	MAX_LINE_VERIFICATIONS_PER_ORG_PER_DAY,
	MAX_STAFF_ALERT_SMS_PER_ORG_PER_DAY,
	parseFinishExtras,
	publicVoiceRoutes,
	RECORDING_PURGE_BUDGET_MS,
	voiceOperatorRoutes,
	voiceSystemRoutes,
} from './voice.ts'

vi.mock('@repo/sms', () => ({
	sendSms: vi.fn().mockResolvedValue({ success: true }),
}))
vi.mock('../lib/tenant-email.ts', () => ({
	sendTenantEmail: vi.fn().mockResolvedValue({
		status: 'success',
		data: { messageId: 'm1' },
	}),
}))
vi.mock('../lib/origin.ts', () => ({
	findActiveOrganizationById: vi.fn(),
	resolveOrganizationForBrowserAuth: vi.fn(),
}))

const orgId = 'clw9x0a12000008l00voice01'
const internalToken = 'test-internal-token-123456789'
const voiceToken = 'test-voice-agent-token-0123456789abcdef'
const operatorSecret = 'test-operator-secret-123456789'
const org = {
	id: orgId,
	slug: 'acme',
	name: 'Acme’s',
	customDomain: null,
	hasProvisionedDb: true,
	dataRegion: 'us',
} as Awaited<ReturnType<typeof findActiveOrganizationById>>

const linkPayload = { items: [{ id: 'item_1', quantity: 2, note: '' }] }
const linkMessage = "{business}: here's what we talked about: {url}"

async function operatorJwt(
	scope?: string,
	extraClaims: Record<string, unknown> = {},
) {
	return new SignJWT({ orgId, role: 'operator', scope, ...extraClaims })
		.setProtectedHeader({ alg: 'HS256' })
		.setAudience('tenant-api-operator')
		.setIssuer(brand.shortName)
		.setExpirationTime('1h')
		.sign(new TextEncoder().encode(operatorSecret))
}

describe('voice routes', () => {
	let tempDir: string
	let app: Hono

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-voice-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.INTERNAL_COMMAND_TOKEN = internalToken
		process.env.VOICE_AGENT_TOKEN = voiceToken
		process.env.TENANT_OPERATOR_TOKEN = operatorSecret
		vi.mocked(findActiveOrganizationById).mockResolvedValue(org)
		vi.mocked(resolveOrganizationForBrowserAuth).mockResolvedValue(
			org as Awaited<ReturnType<typeof resolveOrganizationForBrowserAuth>>,
		)
		vi.mocked(sendSms).mockClear()
		vi.mocked(sendTenantEmail).mockClear()
		await provisionTenantDb(orgId)
		app = new Hono()
		app.route('/api/voice', voiceSystemRoutes)
		app.route('/operator/calls', voiceOperatorRoutes)
		app.route('/voice', publicVoiceRoutes)
	})

	afterEach(async () => {
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	const post = (route: string, body: unknown, token: string) =>
		app.request(route, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
		})
	const internal = (route: string, body: unknown) =>
		post(route, body, voiceToken)
	const command = (route: string, body: unknown) =>
		post(route, body, internalToken)
	const purge = (body: Record<string, unknown> = {}) =>
		command('/api/voice/retention/purge', {
			orgId,
			dataRegion: 'us',
			...body,
		})

	async function callRow(callId: string) {
		const db = await getTenantDb(orgId)
		const [row] = await db
			.select()
			.from(voiceCalls)
			.where(eq(voiceCalls.id, callId))
		return row!
	}

	async function startCall(
		roomName: string,
		extra: Record<string, unknown> = {},
	) {
		const res = await internal('/api/voice/calls', {
			orgId,
			channel: 'phone',
			roomName,
			...extra,
		})
		return ((await res.json()) as { callId: string }).callId
	}

	it('rejects calls without the voice agent token', async () => {
		const res = await app.request('/api/voice/calls', {
			method: 'POST',
			body: JSON.stringify({ orgId }),
		})
		expect(res.status).toBe(401)
		const withInternal = await command('/api/voice/calls', {
			orgId,
			channel: 'phone',
			roomName: 'room-internal',
		})
		expect(withInternal.status).toBe(401)
	})

	it('refuses the voice agent while its token is unusable', async () => {
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
		const start = (token: string) =>
			post(
				'/api/voice/calls',
				{ orgId, channel: 'phone', roomName: 'room-config' },
				token,
			)
		process.env.VOICE_AGENT_TOKEN = 'short-voice-token'
		const short = await start('short-voice-token')
		expect(short.status).toBe(503)
		expect(await short.json()).toEqual({ error: 'Not configured' })

		process.env.VOICE_AGENT_TOKEN = voiceToken
		process.env.INTERNAL_COMMAND_TOKEN = voiceToken
		expect((await start(voiceToken)).status).toBe(503)
		expect(errors).toHaveBeenCalledWith(
			'Voice agent routes are disabled: VOICE_AGENT_TOKEN must differ from INTERNAL_COMMAND_TOKEN',
		)

		process.env.INTERNAL_COMMAND_TOKEN = internalToken
		expect((await start(voiceToken)).status).toBe(201)
		errors.mockRestore()
	})

	describe('operator region guard', () => {
		const call = (route: string, jwt: string, init: RequestInit = {}) =>
			app.request(route, {
				...init,
				headers: {
					Authorization: `Bearer ${jwt}`,
					'Content-Type': 'application/json',
				},
			})

		it('refuses orgs from another region on every operator route', async () => {
			const callId = await startCall('guarded')
			const reader = await operatorJwt('phone_calls')
			const editor = await operatorJwt('phone_calls', { canUpdate: true })
			const deleter = await operatorJwt('phone_calls', { canDelete: true })
			vi.mocked(findActiveOrganizationById).mockResolvedValue({
				...org!,
				dataRegion: 'ksa',
			})
			const responses = [
				await call('/operator/calls', reader),
				await call('/operator/calls/requests', reader),
				await call(`/operator/calls/${callId}`, reader),
				await call(`/operator/calls/${callId}`, editor, {
					method: 'PATCH',
					body: JSON.stringify({ followUpStatus: 'resolved' }),
				}),
				await call('/operator/calls/requests/some-request', editor, {
					method: 'PATCH',
					body: JSON.stringify({ status: 'done' }),
				}),
				await call(`/operator/calls/${callId}`, deleter, { method: 'DELETE' }),
				await call('/operator/calls/erase', deleter, {
					method: 'POST',
					body: JSON.stringify({ phone: '+12125551111' }),
				}),
			]
			for (const res of responses) {
				expect(res.status).toBe(409)
				expect(await res.json()).toMatchObject({
					error: 'region_mismatch',
					message: expect.stringContaining('"ksa"'),
				})
			}
			const db = await getTenantDb(orgId)
			expect(await db.select().from(voiceCalls)).toHaveLength(1)
		})

		it('refuses orgs without a provisioned database or that are gone', async () => {
			const reader = await operatorJwt('phone_calls')
			vi.mocked(findActiveOrganizationById).mockResolvedValue({
				...org!,
				hasProvisionedDb: false,
			})
			const unprovisioned = await call('/operator/calls', reader)
			expect(unprovisioned.status).toBe(409)
			expect(await unprovisioned.json()).toMatchObject({
				error: 'tenant_not_provisioned',
			})

			vi.mocked(findActiveOrganizationById).mockResolvedValue(null)
			const missing = await call('/operator/calls', reader)
			expect(missing.status).toBe(404)
			expect(await missing.json()).toEqual({
				error: 'Organization is not available in this region',
			})
		})

		it('still checks permissions before the region', async () => {
			const callId = await startCall('guarded-permissions')
			const reader = await operatorJwt('phone_calls')
			vi.mocked(findActiveOrganizationById).mockResolvedValue({
				...org!,
				dataRegion: 'ksa',
			})
			const res = await call(`/operator/calls/${callId}`, reader, {
				method: 'DELETE',
			})
			expect(res.status).toBe(403)
		})
	})

	it('refuses organizations from another region', async () => {
		vi.mocked(findActiveOrganizationById).mockResolvedValueOnce({
			...org!,
			dataRegion: 'ksa',
		})
		const res = await internal('/api/voice/calls', {
			orgId,
			channel: 'phone',
			roomName: 'room-ksa',
		})
		expect(res.status).toBe(404)
	})

	it('logs a call, texts a handoff link, and opens it once', async () => {
		const db = await getTenantDb(orgId)
		await db.insert(customers).values({ name: 'Ada', phone: '+12125551111' })

		const start = await internal('/api/voice/calls', {
			orgId,
			channel: 'phone',
			roomName: 'call-1',
			callerPhone: '+12125551111',
		})
		expect(start.status).toBe(201)
		const startBody = (await start.json()) as { callId: string }
		// Caller ID is spoofable: the worker never learns who the number belongs to.
		expect(startBody).toEqual({ callId: expect.any(String) })
		const { callId } = startBody
		const [linked] = await db
			.select({ customerId: voiceCalls.customerId })
			.from(voiceCalls)
			.where(eq(voiceCalls.id, callId))
		expect(linked!.customerId).not.toBeNull()

		const again = await internal('/api/voice/calls', {
			orgId,
			channel: 'phone',
			roomName: 'call-1',
			callerPhone: '+12125551111',
		})
		expect(await again.json()).toEqual({ callId })

		const handoff = await internal('/api/voice/handoffs', {
			orgId,
			callId,
			scopeId: 'scope_1',
			path: '/book?scope=scope_1',
			payload: linkPayload,
			message: linkMessage,
			sendTo: '+12125551111',
		})
		expect(handoff.status).toBe(201)
		const handoffBody = (await handoff.json()) as {
			url: string
			smsSent: boolean
		}
		expect(handoffBody.smsSent).toBe(true)
		expect(handoffBody.url).toMatch(
			/^https:\/\/acme\..+\/book\?scope=scope_1#handoff=[\w-]+$/,
		)
		expect(vi.mocked(sendSms)).toHaveBeenCalledWith({
			to: '+12125551111',
			message: `Acme’s: here's what we talked about: ${handoffBody.url}`,
		})

		const token = new URLSearchParams(
			new URL(handoffBody.url).hash.slice(1),
		).get('handoff')!
		const [stored] = await db.select().from(voiceLinkHandoffs)
		expect(stored!.tokenHash).not.toBe(token)
		expect(stored).toMatchObject({
			scopeId: 'scope_1',
			path: '/book?scope=scope_1',
			payload: linkPayload,
		})

		const opened = await app.request(`/voice/handoffs/${token}?slug=acme`)
		expect(opened.status).toBe(200)
		expect(await opened.json()).toEqual({
			path: '/book?scope=scope_1',
			payload: linkPayload,
			scopeId: 'scope_1',
			expiresAt: expect.any(String),
		})

		const missing = await app.request(
			`/voice/handoffs/${'x'.repeat(32)}?slug=acme`,
		)
		expect(missing.status).toBe(410)

		const finish = await internal(`/api/voice/calls/${callId}/finish`, {
			orgId,
			purpose: 'scheduling',
			outcome: 'link_sent',
			summary: 'Booked a visit',
			transcript: [{ role: 'caller', text: 'Friday works for me', at: 1 }],
			durationSeconds: 95,
		})
		expect(finish.status).toBe(200)

		const request = await internal('/api/voice/requests', {
			orgId,
			callId,
			type: 'appointment',
			callerName: 'Ada',
			details: { people: '4', time: 'Friday 7pm' },
		})
		expect(request.status).toBe(201)

		const unscoped = await app.request('/operator/calls', {
			headers: { Authorization: `Bearer ${await operatorJwt()}` },
		})
		expect(unscoped.status).toBe(401)

		const jwt = await operatorJwt('phone_calls')
		const list = await app.request('/operator/calls', {
			headers: { Authorization: `Bearer ${jwt}` },
		})
		const listBody = (await list.json()) as {
			calls: Array<{ id: string; purpose: string; customerName: string }>
			purposeCounts: Array<{ purpose: string; total: number }>
			openRequests: number
		}
		expect(listBody.calls[0]).toMatchObject({
			id: callId,
			purpose: 'scheduling',
			scopeId: null,
			customerName: 'Ada',
		})
		expect(listBody.purposeCounts).toEqual([
			{ purpose: 'scheduling', total: 1 },
		])
		expect(listBody.openRequests).toBe(1)

		const detail = await app.request(`/operator/calls/${callId}`, {
			headers: { Authorization: `Bearer ${jwt}` },
		})
		const detailBody = (await detail.json()) as {
			call: { transcript: unknown[]; hasRecording?: boolean }
			handoffs: Array<Record<string, unknown>>
			requests: unknown[]
		}
		expect(detailBody.call.transcript).toHaveLength(1)
		expect(detailBody.call).not.toHaveProperty('recordingKey')
		expect(detailBody.call.hasRecording).toBe(false)
		expect(detailBody.handoffs).toEqual([
			expect.objectContaining({
				id: expect.any(String),
				scopeId: 'scope_1',
				path: '/book?scope=scope_1',
				payload: linkPayload,
				createdAt: expect.any(String),
				expiresAt: expect.any(String),
			}),
		])
		expect(detailBody.handoffs[0]).not.toHaveProperty('tokenHash')
		expect(detailBody.requests).toHaveLength(1)

		const { id: requestId } = detailBody.requests[0] as { id: string }
		const setRequestStatus = (token: string) =>
			app.request(`/operator/calls/requests/${requestId}`, {
				method: 'PATCH',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ status: 'done' }),
			})
		expect((await setRequestStatus(jwt)).status).toBe(403)
		const updateJwt = await operatorJwt('phone_calls', { canUpdate: true })
		expect((await setRequestStatus(updateJwt)).status).toBe(200)

		const forbidden = await app.request(`/operator/calls/${callId}`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${jwt}` },
		})
		expect(forbidden.status).toBe(403)

		const deleteJwt = await operatorJwt('phone_calls', { canDelete: true })
		const deleted = await app.request(`/operator/calls/${callId}`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${deleteJwt}` },
		})
		expect(deleted.status).toBe(200)
	})

	it('texts a site link from a phone menu', async () => {
		const start = await internal('/api/voice/calls', {
			orgId,
			channel: 'phone',
			roomName: 'call-link',
			callerPhone: '+12125552222',
		})
		const { callId } = (await start.json()) as { callId: string }

		const res = await internal('/api/voice/website-links', {
			orgId,
			callId,
			scopeId: 'scope_1',
			path: '/visit?scope=scope_1',
			message: 'Book with {business} here: {url}',
			sendTo: '+12125552222',
			businessName: 'Ignored Name',
		})
		expect(res.status).toBe(201)
		const body = (await res.json()) as { url: string; smsSent: boolean }
		expect(body.smsSent).toBe(true)
		expect(body.url).toMatch(/^https:\/\/acme\..+\/visit\?scope=scope_1$/)
		expect(vi.mocked(sendSms)).toHaveBeenCalledWith({
			to: '+12125552222',
			message: `Book with Acme’s here: ${body.url}`,
		})

		const unknownCall = await internal('/api/voice/website-links', {
			orgId,
			callId: '00000000-0000-4000-8000-000000000000',
		})
		expect(unknownCall.status).toBe(404)
	})

	it('defaults the website link to the home page and a generic message', async () => {
		const callId = await startCall('call-link-default', {
			callerPhone: '+12125552223',
		})
		const res = await internal('/api/voice/website-links', { orgId, callId })
		const body = (await res.json()) as { url: string; smsSent: boolean }
		expect(body.url).toMatch(/^https:\/\/acme\.[^/]+\/$/)
		expect(vi.mocked(sendSms)).toHaveBeenCalledWith({
			to: '+12125552223',
			message: `Acme’s: here's the link you asked for: ${body.url}`,
		})
	})

	it('rejects website links with a bad path or message', async () => {
		const callId = await startCall('call-link-invalid', {
			callerPhone: '+12125552224',
		})
		for (const body of [
			{ path: 'visit' },
			{ path: '//evil.example/path' },
			{ path: '/visit#section' },
			{ message: 'No link here' },
			{ message: `${'x'.repeat(LINK_MESSAGE_MAX_CHARS)}{url}` },
		]) {
			const res = await internal('/api/voice/website-links', {
				orgId,
				callId,
				...body,
			})
			expect(res.status).toBe(400)
		}
		expect(vi.mocked(sendSms)).not.toHaveBeenCalled()
	})

	it('rejects handoffs with a bad path, message, or payload', async () => {
		const callId = await startCall('handoff-invalid', {
			callerPhone: '+12125552225',
		})
		const valid = {
			orgId,
			callId,
			path: '/book',
			payload: linkPayload,
			message: linkMessage,
		}
		for (const body of [
			{ ...valid, path: '/book#section' },
			{ ...valid, path: 'https://evil.example/book' },
			{ ...valid, message: 'Missing the link' },
			{ ...valid, message: undefined },
			{ ...valid, payload: undefined },
			{ ...valid, payload: null },
			{ ...valid, payload: { note: 'x'.repeat(32_000) } },
		]) {
			const res = await internal('/api/voice/handoffs', body)
			expect(res.status).toBe(400)
		}
		const db = await getTenantDb(orgId)
		expect(await db.select().from(voiceLinkHandoffs)).toHaveLength(0)
		expect(vi.mocked(sendSms)).not.toHaveBeenCalled()
	})

	it('accepts any definition slug for purposes and request types', async () => {
		const callId = await startCall('slug-check')
		const badRequest = await internal('/api/voice/requests', {
			orgId,
			callId,
			type: 'Not A Slug',
			details: {},
		})
		expect(badRequest.status).toBe(400)
		const goodRequest = await internal('/api/voice/requests', {
			orgId,
			callId,
			type: 'quote_request',
			details: {},
		})
		expect(goodRequest.status).toBe(201)
		const badFinish = await internal(`/api/voice/calls/${callId}/finish`, {
			orgId,
			purpose: 'bad-purpose',
			outcome: 'resolved',
			transcript: [],
			durationSeconds: 1,
		})
		expect(badFinish.status).toBe(400)
	})

	describe('SMS restrictions', () => {
		const handoff = (callId: string, sendTo?: string) =>
			internal('/api/voice/handoffs', {
				orgId,
				callId,
				path: '/book',
				payload: linkPayload,
				message: linkMessage,
				...(sendTo ? { sendTo } : {}),
			})

		it('texts the caller number and uses the stored organization name', async () => {
			const callId = await startCall('sms-caller', {
				callerPhone: '+14165550123',
			})
			const res = await handoff(callId)
			const body = (await res.json()) as { smsSent: boolean; url: string }
			expect(body.smsSent).toBe(true)
			expect(vi.mocked(sendSms)).toHaveBeenCalledWith({
				to: '+14165550123',
				message: expect.stringMatching(
					/^Acme’s: here's what we talked about: /,
				),
			})
		})

		it.each([
			['an international', '+447700900123'],
			['a Caribbean "+1"', '+18765550123'],
			['a premium-rate', '+19005550123'],
		])(
			'never texts %s caller ID, even the caller’s own number',
			async (_label, callerPhone) => {
				const callId = await startCall(`sms-spoofed-${callerPhone}`, {
					callerPhone,
				})
				const ownNumber = await handoff(callId)
				expect(await ownNumber.json()).toMatchObject({
					smsSent: false,
					smsBlockedReason: 'not_allowed_number',
					handoffId: null,
				})
				const explicit = await internal('/api/voice/website-links', {
					orgId,
					callId,
					sendTo: callerPhone,
				})
				expect(await explicit.json()).toMatchObject({
					smsSent: false,
					smsBlockedReason: 'not_allowed_number',
				})
				expect(vi.mocked(sendSms)).not.toHaveBeenCalled()
				const db = await getTenantDb(orgId)
				const logs = await db.select().from(voiceSmsSends)
				expect(logs.map((log) => log.status)).toEqual(['blocked', 'blocked'])
			},
		)

		it('does not exceed the per-call cap under concurrent requests', async () => {
			let releaseSends: () => void = () => {}
			const sendsReleased = new Promise<void>((resolve) => {
				releaseSends = resolve
			})
			// Hold Twilio so every request is in flight at the same time.
			vi.mocked(sendSms).mockImplementation(async () => {
				await sendsReleased
				return { success: true } as Awaited<ReturnType<typeof sendSms>>
			})
			try {
				const callId = await startCall('sms-race', {
					callerPhone: '+12125554444',
				})
				const pending = Promise.all(
					Array.from({ length: 4 }, () => handoff(callId)),
				)
				await vi.waitFor(() =>
					expect(vi.mocked(sendSms)).toHaveBeenCalledTimes(2),
				)
				releaseSends()
				const bodies = await Promise.all(
					(await pending).map(
						async (res) =>
							(await res.json()) as {
								smsSent: boolean
								smsBlockedReason?: string
							},
					),
				)
				expect(bodies.filter((body) => body.smsSent)).toHaveLength(2)
				expect(
					bodies
						.filter((body) => !body.smsSent)
						.map((body) => body.smsBlockedReason),
				).toEqual(['call_limit', 'call_limit'])
				expect(vi.mocked(sendSms)).toHaveBeenCalledTimes(2)
			} finally {
				releaseSends()
				vi.mocked(sendSms).mockResolvedValue({ success: true } as Awaited<
					ReturnType<typeof sendSms>
				>)
			}
		})

		it('does not exceed the daily org cap under concurrent requests', async () => {
			const earlier = await startCall('sms-daily-earlier')
			const db = await getTenantDb(orgId)
			await db.insert(voiceSmsSends).values(
				Array.from({ length: 299 }, () => ({
					callId: earlier,
					kind: 'website_link' as const,
					toPhone: '+12125550123',
					status: 'sent' as const,
				})),
			)
			const calls = await Promise.all(
				['sms-daily-a', 'sms-daily-b', 'sms-daily-c'].map((room) =>
					startCall(room, { callerPhone: '+12125554445' }),
				),
			)
			const results = await Promise.all(
				calls.map(async (callId) => {
					const res = await internal('/api/voice/website-links', {
						orgId,
						callId,
					})
					return (await res.json()) as {
						smsSent: boolean
						smsBlockedReason?: string
					}
				}),
			)
			expect(results.filter((result) => result.smsSent)).toHaveLength(1)
			expect(
				results
					.filter((result) => !result.smsSent)
					.map((result) => result.smsBlockedReason),
			).toEqual(['daily_limit', 'daily_limit'])
			expect(vi.mocked(sendSms)).toHaveBeenCalledTimes(1)
		})

		it('blocks foreign numbers that are not the caller and drops the handoff', async () => {
			const callId = await startCall('sms-foreign', {
				callerPhone: '+12125553333',
			})
			const res = await handoff(callId, '+966501234567')
			expect(res.status).toBe(201)
			const body = (await res.json()) as {
				smsSent: boolean
				smsBlockedReason: string
				handoffId: string | null
			}
			expect(body).toMatchObject({
				smsSent: false,
				smsBlockedReason: 'not_allowed_number',
				handoffId: null,
			})
			expect(vi.mocked(sendSms)).not.toHaveBeenCalled()
			const db = await getTenantDb(orgId)
			expect(await db.select().from(voiceLinkHandoffs)).toHaveLength(0)
			const [log] = await db.select().from(voiceSmsSends)
			expect(log).toMatchObject({
				status: 'blocked',
				reason: 'not_allowed_number',
				kind: 'handoff_link',
			})
		})

		it('allows other US numbers and caps texts per call', async () => {
			const callId = await startCall('sms-cap', {
				callerPhone: '+12125554444',
			})
			const first = await handoff(callId, '+12125550123')
			expect(((await first.json()) as { smsSent: boolean }).smsSent).toBe(true)
			const second = await internal('/api/voice/website-links', {
				orgId,
				callId,
			})
			expect(((await second.json()) as { smsSent: boolean }).smsSent).toBe(true)
			const third = await handoff(callId)
			expect(await third.json()).toMatchObject({
				smsSent: false,
				smsBlockedReason: 'call_limit',
			})
			expect(vi.mocked(sendSms)).toHaveBeenCalledTimes(2)
		})

		it('records a failed send and removes the unsent handoff', async () => {
			vi.mocked(sendSms).mockRejectedValueOnce(new Error('twilio down'))
			const callId = await startCall('sms-fail', {
				callerPhone: '+12125555555',
			})
			const res = await handoff(callId)
			expect(await res.json()).toMatchObject({
				smsSent: false,
				smsBlockedReason: 'send_failed',
				url: null,
			})
			const db = await getTenantDb(orgId)
			expect(await db.select().from(voiceLinkHandoffs)).toHaveLength(0)
			const [log] = await db.select().from(voiceSmsSends)
			expect(log).toMatchObject({ status: 'failed', reason: 'send_failed' })
		})

		it('never texts from browser test calls but keeps the link', async () => {
			const callId = await startCall('sms-test', { channel: 'web_test' })
			const res = await handoff(callId, '+12125550123')
			const body = (await res.json()) as {
				smsSent: boolean
				smsBlockedReason: string
				url: string
				handoffId: string
			}
			expect(body.smsSent).toBe(false)
			expect(body.smsBlockedReason).toBe('test_call')
			expect(body.handoffId).toEqual(expect.any(String))
			expect(body.url).toContain('#handoff=')
			expect(vi.mocked(sendSms)).not.toHaveBeenCalled()
			const db = await getTenantDb(orgId)
			const [log] = await db.select().from(voiceSmsSends)
			expect(log).toMatchObject({ status: 'skipped', reason: 'test_call' })
		})

		it('does not text from the KSA node', async () => {
			process.env.DATA_REGION = 'ksa'
			vi.mocked(findActiveOrganizationById).mockResolvedValue({
				...org!,
				dataRegion: 'ksa',
			})
			try {
				const callId = await startCall('sms-ksa', {
					callerPhone: '+966501234567',
				})
				const res = await internal('/api/voice/website-links', {
					orgId,
					callId,
				})
				expect(await res.json()).toMatchObject({
					smsSent: false,
					smsBlockedReason: 'unavailable_region',
				})
				expect(vi.mocked(sendSms)).not.toHaveBeenCalled()
			} finally {
				process.env.DATA_REGION = 'us'
			}
		})
	})

	describe('call lifecycle', () => {
		const finishBody = {
			orgId,
			outcome: 'resolved',
			transcript: [{ role: 'caller', text: 'Hi', at: 0 }],
			durationSeconds: 10,
		}

		it('returns the same call for concurrent starts', async () => {
			const results = await Promise.all(
				Array.from({ length: 5 }, () =>
					internal('/api/voice/calls', {
						orgId,
						channel: 'phone',
						roomName: 'race-room',
					}),
				),
			)
			const ids = await Promise.all(
				results.map(async (res) => {
					expect([200, 201]).toContain(res.status)
					return ((await res.json()) as { callId: string }).callId
				}),
			)
			expect(new Set(ids).size).toBe(1)
		})

		it('finishes once and ignores repeats', async () => {
			const callId = await startCall('finish-once')
			const first = await internal(`/api/voice/calls/${callId}/finish`, {
				...finishBody,
				summary: 'first',
				recordingRetentionDays: 30,
			})
			expect(await first.json()).toEqual({ success: true })
			const again = await internal(`/api/voice/calls/${callId}/finish`, {
				...finishBody,
				summary: 'second',
			})
			expect(await again.json()).toEqual({
				success: true,
				alreadyFinished: true,
			})
			const db = await getTenantDb(orgId)
			const [call] = await db.select().from(voiceCalls)
			expect(call!.summary).toBe('first')
			const days =
				(call!.transcriptExpiresAt!.getTime() - call!.endedAt!.getTime()) /
				86_400_000
			expect(Math.round(days)).toBe(30)

			const missing = await internal(
				'/api/voice/calls/00000000-0000-4000-8000-000000000000/finish',
				finishBody,
			)
			expect(missing.status).toBe(404)
		})

		it('only accepts the recording key the worker writes for this call', async () => {
			const callId = await startCall('recording-key')
			for (const recordingKey of [
				'../../etc/passwd',
				`voice-recordings/${orgId}/../other/${callId}.ogg`,
				`voice-recordings/other-org/${callId}.ogg`,
				`voice-recordings/${orgId}/00000000-0000-4000-8000-000000000000.ogg`,
				`voice-recordings/${orgId}/${callId}.mp3`,
			]) {
				const res = await internal(`/api/voice/calls/${callId}/finish`, {
					...finishBody,
					recordingKey,
				})
				expect(res.status).toBe(400)
			}
			const db = await getTenantDb(orgId)
			expect((await db.select().from(voiceCalls))[0]!.endedAt).toBeNull()

			const key = `voice-recordings/${orgId}/${callId}.ogg`
			const res = await internal(`/api/voice/calls/${callId}/finish`, {
				...finishBody,
				recordingKey: key,
			})
			expect(res.status).toBe(200)
			const [call] = await db.select().from(voiceCalls)
			expect(call!.recordingKey).toBe(key)
			expect(call!.recordingExpiresAt).toBeInstanceOf(Date)
		})

		it('truncates long transcripts and rejects oversized bodies', async () => {
			const callId = await startCall('long-call')
			const res = await internal(`/api/voice/calls/${callId}/finish`, {
				...finishBody,
				transcript: Array.from({ length: 450 }, (_, at) => ({
					role: 'caller',
					text: 'x'.repeat(1500),
					at,
				})),
			})
			expect(res.status).toBe(200)
			const db = await getTenantDb(orgId)
			const [call] = await db.select().from(voiceCalls)
			expect(call!.transcript).toHaveLength(400)
			expect(call!.transcript[0]!.text).toHaveLength(1000)

			const tooLarge = await internal(`/api/voice/calls/${callId}/finish`, {
				...finishBody,
				summary: 'x'.repeat(1024 * 1024),
			})
			expect(tooLarge.status).toBe(413)
		})

		it('pages the call list with a keyset cursor', async () => {
			for (const room of ['page-1', 'page-2', 'page-3']) await startCall(room)
			const jwt = await operatorJwt('phone_calls')
			const seen: string[] = []
			let cursor: string | null = null
			do {
				const query: string = cursor ? `&cursor=${cursor}` : ''
				const res = await app.request(`/operator/calls?limit=2${query}`, {
					headers: { Authorization: `Bearer ${jwt}` },
				})
				const body = (await res.json()) as {
					calls: Array<{ id: string }>
					nextCursor: string | null
				}
				seen.push(...body.calls.map((call) => call.id))
				cursor = body.nextCursor
			} while (cursor)
			expect(seen).toHaveLength(3)
			expect(new Set(seen).size).toBe(3)

			const invalid = await app.request('/operator/calls?cursor=abc', {
				headers: { Authorization: `Bearer ${jwt}` },
			})
			expect(invalid.status).toBe(400)
		})
	})

	describe('call follow-up and staff alerts', () => {
		const callsUrl = 'https://app.example.test/acme/phone-agent/calls'
		const notifications = {
			smsNumbers: ['+12125550100'],
			emails: ['team@example.com'],
			events: ['voicemail', 'complaint'],
			includeCallLink: true,
		}
		const finish = (callId: string, extra: Record<string, unknown> = {}) =>
			internal(`/api/voice/calls/${callId}/finish`, {
				orgId,
				outcome: 'message_taken',
				summary: 'Wants a call back about billing',
				transcript: [{ role: 'caller', text: 'Hi', at: 0 }],
				durationSeconds: 95,
				...extra,
			})
		const patch = (callId: string, body: unknown, jwt: string) =>
			app.request(`/operator/calls/${callId}`, {
				method: 'PATCH',
				headers: {
					Authorization: `Bearer ${jwt}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(body),
			})

		it('stores the extras and opens a follow-up when staff need to act', async () => {
			const callId = await startCall('follow-up-open', {
				callerPhone: '+12125558888',
			})
			await internal('/api/voice/requests', {
				orgId,
				callId,
				type: 'callback',
				details: { reason: 'billing' },
			})
			const res = await finish(callId, {
				tags: ['complaint', 'complaint', 'vip'],
				rating: 2,
				sentiment: 'negative',
				transferResult: 'no_answer',
				transferContactId: 'manager',
				voicemail: true,
				calledWhileOpen: true,
				followUp: { autoResolveAfterDays: 7, keepTransferredOpen: false },
			})
			expect(await res.json()).toEqual({ success: true })
			const row = await callRow(callId)
			expect(row).toMatchObject({
				followUpStatus: 'open',
				followUpResolvedAt: null,
				tags: ['complaint', 'vip'],
				rating: 2,
				sentiment: 'negative',
				transferResult: 'no_answer',
				transferContactId: 'manager',
				voicemail: true,
				calledWhileOpen: true,
				linkSent: false,
			})
			const days =
				(row.autoResolveAt!.getTime() - row.endedAt!.getTime()) / 86_400_000
			expect(days).toBe(7)
		})

		it('keeps important calls open without auto-resolve', async () => {
			const callId = await startCall('follow-up-important')
			await finish(callId, {
				outcome: 'resolved',
				tags: ['vip'],
				importantTagIds: ['vip'],
				followUp: { autoResolveAfterDays: 3, keepTransferredOpen: false },
			})
			expect(await callRow(callId)).toMatchObject({
				followUpStatus: 'open',
				autoResolveAt: null,
			})
		})

		it('resolves routine calls and records sent links', async () => {
			const callId = await startCall('follow-up-resolved', {
				callerPhone: '+12125559999',
			})
			await internal('/api/voice/website-links', { orgId, callId })
			await finish(callId, { outcome: 'link_sent' })
			const row = await callRow(callId)
			expect(row).toMatchObject({
				followUpStatus: 'resolved',
				autoResolveAt: null,
				linkSent: true,
				tags: [],
				transferResult: 'none',
				voicemail: false,
				calledWhileOpen: null,
			})
			expect(row.followUpResolvedAt).toBeInstanceOf(Date)
		})

		it('tolerates invalid extras field by field', async () => {
			const callId = await startCall('follow-up-invalid')
			const res = await finish(callId, {
				outcome: 'resolved',
				rating: 9,
				tags: ['ok', 'Not A Tag'],
				sentiment: 'positive',
				notifications: { smsNumbers: 'nope' },
				callsUrl: 'not a url',
			})
			expect(res.status).toBe(200)
			expect(await callRow(callId)).toMatchObject({
				rating: null,
				tags: [],
				sentiment: 'positive',
				followUpStatus: 'resolved',
			})
			expect(parseFinishExtras(null)).toMatchObject({
				tags: [],
				transferResult: 'none',
				notifications: null,
			})
		})

		it('alerts staff once for subscribed events on phone calls', async () => {
			const callId = await startCall('alert-phone', {
				callerPhone: '+12125551234',
			})
			const body = { voicemail: true, notifications, callsUrl }
			expect((await finish(callId, body)).status).toBe(200)
			expect(vi.mocked(sendSms)).toHaveBeenCalledTimes(1)
			const sms = vi.mocked(sendSms).mock.calls[0]![0]
			expect(sms.to).toBe('+12125550100')
			expect(sms.message).toContain('Acme’s: New voicemail')
			expect(sms.message).toContain('From +12125551234')
			expect(sms.message).toContain(`${callsUrl}?call=${callId}`)
			expect(vi.mocked(sendTenantEmail)).toHaveBeenCalledTimes(1)
			expect(vi.mocked(sendTenantEmail).mock.calls[0]![0]).toMatchObject({
				to: 'team@example.com',
				subject: 'Acme’s: New voicemail',
			})

			expect(await (await finish(callId, body)).json()).toEqual({
				success: true,
				alreadyFinished: true,
			})
			expect(vi.mocked(sendSms)).toHaveBeenCalledTimes(1)
			expect(vi.mocked(sendTenantEmail)).toHaveBeenCalledTimes(1)

			const db = await getTenantDb(orgId)
			const [log] = await db
				.select()
				.from(voiceSmsSends)
				.where(eq(voiceSmsSends.callId, callId))
			expect(log).toMatchObject({ kind: 'staff_alert', status: 'sent' })
		})

		it('uses tag names and omits the link when asked', async () => {
			const callId = await startCall('alert-tags')
			await finish(callId, {
				tags: ['complaint', 'needs_review'],
				notifications: { ...notifications, includeCallLink: false },
				callsUrl,
			})
			const sms = vi.mocked(sendSms).mock.calls[0]![0]
			expect(sms.message).toContain('Acme’s: Complaint')
			expect(sms.message).toContain('Tags: Complaint, Needs review')
			expect(sms.message).not.toContain(callsUrl)
		})

		it('does not alert for test calls or unsubscribed events', async () => {
			const testCall = await startCall('alert-test', { channel: 'web_test' })
			await finish(testCall, { voicemail: true, notifications, callsUrl })
			const quiet = await startCall('alert-quiet')
			await finish(quiet, { outcome: 'resolved', notifications, callsUrl })
			expect(vi.mocked(sendSms)).not.toHaveBeenCalled()
			expect(vi.mocked(sendTenantEmail)).not.toHaveBeenCalled()
		})

		it('does not fail the finish when alerts fail', async () => {
			vi.mocked(sendSms).mockRejectedValueOnce(new Error('twilio down'))
			vi.mocked(sendTenantEmail).mockRejectedValueOnce(new Error('oci down'))
			const callId = await startCall('alert-fail')
			const res = await finish(callId, { voicemail: true, notifications })
			expect(await res.json()).toEqual({ success: true })
			const db = await getTenantDb(orgId)
			const [log] = await db
				.select()
				.from(voiceSmsSends)
				.where(eq(voiceSmsSends.callId, callId))
			expect(log).toMatchObject({ status: 'failed', reason: 'send_failed' })
		})

		it('caps staff alerts separately from caller texts', async () => {
			const alerted = await startCall('alert-cap')
			const db = await getTenantDb(orgId)
			await db.insert(voiceSmsSends).values(
				Array.from({ length: MAX_STAFF_ALERT_SMS_PER_ORG_PER_DAY }, () => ({
					callId: alerted,
					kind: 'staff_alert' as const,
					toPhone: '+12125550100',
					status: 'sent' as const,
				})),
			)
			await finish(alerted, { voicemail: true, notifications })
			expect(vi.mocked(sendSms)).not.toHaveBeenCalled()
			const blocked = await db
				.select()
				.from(voiceSmsSends)
				.where(eq(voiceSmsSends.status, 'blocked'))
			expect(blocked).toEqual([
				expect.objectContaining({
					kind: 'staff_alert',
					reason: 'daily_limit',
				}),
			])
			// The caller can still be texted on the same call.
			const caller = await internal('/api/voice/website-links', {
				orgId,
				callId: alerted,
				sendTo: '+12125550123',
			})
			expect(await caller.json()).toMatchObject({ smsSent: true })
		})

		it('lets operators resolve, reopen, and retag calls', async () => {
			const callId = await startCall('patch-call')
			await finish(callId, {
				voicemail: true,
				followUp: { autoResolveAfterDays: 7, keepTransferredOpen: false },
			})
			const reader = await operatorJwt('phone_calls')
			const deleter = await operatorJwt('phone_calls', { canDelete: true })
			const editor = await operatorJwt('phone_calls', { canUpdate: true })

			expect(
				(await patch(callId, { followUpStatus: 'resolved' }, reader)).status,
			).toBe(403)
			expect(
				(await patch(callId, { followUpStatus: 'resolved' }, deleter)).status,
			).toBe(403)
			expect((await patch(callId, {}, editor)).status).toBe(400)
			expect((await patch(callId, { tags: ['Bad Tag'] }, editor)).status).toBe(
				400,
			)
			expect(
				(
					await patch(
						'00000000-0000-4000-8000-000000000000',
						{ followUpStatus: 'resolved' },
						editor,
					)
				).status,
			).toBe(404)

			const resolved = await patch(
				callId,
				{ followUpStatus: 'resolved', tags: ['vip', 'vip', 'complaint'] },
				editor,
			)
			expect(await resolved.json()).toMatchObject({
				success: true,
				call: {
					id: callId,
					followUpStatus: 'resolved',
					autoResolveAt: null,
					tags: ['vip', 'complaint'],
				},
			})
			let row = await callRow(callId)
			expect(row.followUpResolvedAt).toBeInstanceOf(Date)
			expect(row.autoResolveAt).toBeNull()

			await patch(callId, { followUpStatus: 'open' }, editor)
			row = await callRow(callId)
			expect(row).toMatchObject({
				followUpStatus: 'open',
				followUpResolvedAt: null,
				tags: ['vip', 'complaint'],
			})
		})

		it('filters the call list by follow-up and tag', async () => {
			const open = await startCall('list-open')
			await finish(open, { voicemail: true, tags: ['complaint'] })
			const done = await startCall('list-done')
			await finish(done, { outcome: 'resolved', tags: ['vip'] })
			await startCall('list-unfinished')
			const jwt = await operatorJwt('phone_calls')
			const list = async (query: string) => {
				const res = await app.request(`/operator/calls?${query}`, {
					headers: { Authorization: `Bearer ${jwt}` },
				})
				expect(res.status).toBe(200)
				return (await res.json()) as {
					calls: Array<Record<string, unknown>>
					openFollowUps: number
				}
			}

			const openList = await list('followUp=open')
			expect(openList.openFollowUps).toBe(1)
			expect(openList.calls).toEqual([
				expect.objectContaining({
					id: open,
					followUpStatus: 'open',
					tags: ['complaint'],
					voicemail: true,
					transferResult: 'none',
					rating: null,
					sentiment: null,
					calledWhileOpen: null,
					linkSent: false,
				}),
			])
			const resolvedIds = (await list('followUp=resolved')).calls.map(
				(call) => call.id,
			)
			expect(resolvedIds).toHaveLength(2)
			expect(resolvedIds).toContain(done)
			expect((await list('tag=vip')).calls.map((call) => call.id)).toEqual([
				done,
			])
			expect((await list('tag=complaint&followUp=resolved')).calls).toEqual([])
			const invalid = await app.request('/operator/calls?tag=Bad%20Tag', {
				headers: { Authorization: `Bearer ${jwt}` },
			})
			expect(invalid.status).toBe(400)

			const detail = await app.request(`/operator/calls/${open}`, {
				headers: { Authorization: `Bearer ${jwt}` },
			})
			expect(((await detail.json()) as { call: unknown }).call).toMatchObject({
				followUpStatus: 'open',
				tags: ['complaint'],
				voicemail: true,
				autoResolveAt: null,
				transferContactId: null,
			})
		})

		it('auto-resolves due follow-ups during the retention purge', async () => {
			const due = await startCall('auto-due')
			const later = await startCall('auto-later')
			const db = await getTenantDb(orgId)
			await db
				.update(voiceCalls)
				.set({
					followUpStatus: 'open',
					autoResolveAt: new Date(Date.now() - 1000),
				})
				.where(eq(voiceCalls.id, due))
			await db
				.update(voiceCalls)
				.set({
					followUpStatus: 'open',
					autoResolveAt: new Date(Date.now() + 86_400_000),
				})
				.where(eq(voiceCalls.id, later))
			const res = await purge()
			expect(await res.json()).toMatchObject({ followUpsResolved: 1 })
			const dueRow = await callRow(due)
			expect(dueRow).toMatchObject({
				followUpStatus: 'resolved',
				autoResolveAt: null,
			})
			expect(dueRow.followUpResolvedAt).toBeInstanceOf(Date)
			expect((await callRow(later)).followUpStatus).toBe('open')
		})
	})

	describe('retention and erasure', () => {
		const recordingEnv = {
			RECORDING_S3_BUCKET: 'recordings',
			RECORDING_S3_ENDPOINT: 'https://s3.example.test',
			RECORDING_S3_ACCESS_KEY: 'access',
			RECORDING_S3_SECRET: 'secret',
		}
		let fetchSpy: ReturnType<typeof vi.spyOn>

		beforeEach(() => {
			Object.assign(process.env, recordingEnv)
			fetchSpy = vi
				.spyOn(globalThis, 'fetch')
				.mockResolvedValue(new Response(null, { status: 204 }))
		})

		afterEach(() => {
			for (const key of Object.keys(recordingEnv)) process.env[key] = ''
			fetchSpy.mockRestore()
		})

		it('requires the internal token', async () => {
			const res = await internal('/api/voice/retention/purge', { orgId })
			expect(res.status).toBe(401)
		})

		it('purges expired recordings and caller data', async () => {
			const db = await getTenantDb(orgId)
			await db
				.insert(customers)
				.values({ name: 'Old caller', phone: '+12125556666' })
			const expiredId = await startCall('expired', {
				callerPhone: '+12125556666',
			})
			const freshId = await startCall('fresh', {
				callerPhone: '+12125557777',
			})
			for (const callId of [expiredId, freshId]) {
				await internal('/api/voice/requests', {
					orgId,
					callId,
					type: 'callback',
					callerName: 'Pat',
					details: { note: 'call me back' },
				})
			}
			const past = new Date(Date.now() - 86_400_000)
			await db
				.update(voiceCalls)
				.set({
					summary: 'old',
					recordingKey: `voice-recordings/${orgId}/${expiredId}.ogg`,
					recordingExpiresAt: past,
					transcriptExpiresAt: past,
					transcript: [{ role: 'caller', text: 'secret', at: 0 }],
				})
				.where(eq(voiceCalls.id, expiredId))
			await db
				.update(voiceCalls)
				.set({
					summary: 'new',
					transcriptExpiresAt: new Date(Date.now() + 86_400_000),
				})
				.where(eq(voiceCalls.id, freshId))

			const res = await purge()
			expect(await res.json()).toEqual({
				success: true,
				recordingsDeleted: 1,
				recordingsPending: 0,
				recordingsFailed: 0,
				recordingsDeferred: 0,
				transcriptsCleared: 1,
				requestsCleared: 1,
				handoffsDeleted: 0,
				followUpsResolved: 0,
			})
			expect(fetchSpy).toHaveBeenCalledWith(
				`https://s3.example.test/recordings/voice-recordings/${orgId}/${expiredId}.ogg`,
				expect.objectContaining({ method: 'DELETE' }),
			)
			const rows = await db.select().from(voiceCalls)
			const expired = rows.find((row) => row.id === expiredId)!
			expect(expired).toMatchObject({
				recordingKey: null,
				summary: null,
				callerPhone: null,
				customerId: null,
				transcript: [],
			})
			expect(rows.find((row) => row.id === freshId)!.summary).toBe('new')

			const requests = await db.select().from(voiceCallRequests)
			expect(
				requests.find((request) => request.callId === expiredId),
			).toMatchObject({
				type: 'callback',
				callerName: null,
				callerPhone: null,
				details: {},
			})
			expect(
				requests.find((request) => request.callId === freshId),
			).toMatchObject({
				callerName: 'Pat',
				callerPhone: '+12125557777',
				details: { note: 'call me back' },
			})
		})

		it('purges inactive organizations but checks the region and database', async () => {
			const callId = await startCall('inactive-org')
			// Inactive orgs are not returned by the active-org lookup.
			vi.mocked(findActiveOrganizationById).mockResolvedValue(null)
			const db = await getTenantDb(orgId)
			await db
				.update(voiceCalls)
				.set({
					recordingKey: `voice-recordings/${orgId}/${callId}.ogg`,
					recordingExpiresAt: new Date(Date.now() - 1000),
				})
				.where(eq(voiceCalls.id, callId))

			expect(await (await purge()).json()).toMatchObject({
				recordingsDeleted: 1,
			})
			expect((await purge({ dataRegion: 'ksa' })).status).toBe(404)
			expect(
				(await purge({ orgId: 'clw9x0a12000008l00missing1' })).status,
			).toBe(404)
			expect(
				(await command('/api/voice/retention/purge', { orgId })).status,
			).toBe(400)
		})

		it('queues recordings of deleted calls until storage is configured', async () => {
			for (const key of Object.keys(recordingEnv)) process.env[key] = ''
			const callId = await startCall('queued-delete')
			const key = `voice-recordings/${orgId}/${callId}.ogg`
			const db = await getTenantDb(orgId)
			await db
				.update(voiceCalls)
				.set({ recordingKey: key })
				.where(eq(voiceCalls.id, callId))
			const jwt = await operatorJwt('phone_calls', { canDelete: true })
			const deleted = await app.request(`/operator/calls/${callId}`, {
				method: 'DELETE',
				headers: { Authorization: `Bearer ${jwt}` },
			})
			expect(deleted.status).toBe(200)
			expect(await db.select().from(voiceCalls)).toHaveLength(0)
			expect(await db.select().from(voiceRecordingDeletions)).toEqual([
				expect.objectContaining({ recordingKey: key }),
			])

			expect(await (await purge()).json()).toMatchObject({
				recordingsPending: 1,
				recordingsDeleted: 0,
			})
			expect(await db.select().from(voiceRecordingDeletions)).toHaveLength(1)

			Object.assign(process.env, recordingEnv)
			expect(await (await purge()).json()).toMatchObject({
				recordingsPending: 0,
				recordingsDeleted: 1,
			})
			expect(fetchSpy).toHaveBeenCalledWith(
				`https://s3.example.test/recordings/${key}`,
				expect.objectContaining({ method: 'DELETE' }),
			)
			expect(await db.select().from(voiceRecordingDeletions)).toHaveLength(0)
		})

		it('keeps recording keys when storage is not configured', async () => {
			for (const key of Object.keys(recordingEnv)) process.env[key] = ''
			const callId = await startCall('pending')
			const db = await getTenantDb(orgId)
			await db
				.update(voiceCalls)
				.set({
					recordingKey: 'voice-recordings/x.ogg',
					recordingExpiresAt: new Date(Date.now() - 1000),
				})
				.where(eq(voiceCalls.id, callId))
			const res = await purge()
			expect(await res.json()).toMatchObject({ recordingsPending: 1 })
			const [call] = await db.select().from(voiceCalls)
			expect(call!.recordingKey).toBe('voice-recordings/x.ogg')
		})

		it('deletes the recording when an operator deletes a call', async () => {
			const callId = await startCall('operator-delete')
			const db = await getTenantDb(orgId)
			await db
				.update(voiceCalls)
				.set({ recordingKey: 'voice-recordings/op.ogg' })
				.where(eq(voiceCalls.id, callId))
			const jwt = await operatorJwt('phone_calls', { canDelete: true })
			fetchSpy.mockResolvedValueOnce(new Response(null, { status: 500 }))
			const failed = await app.request(`/operator/calls/${callId}`, {
				method: 'DELETE',
				headers: { Authorization: `Bearer ${jwt}` },
			})
			expect(failed.status).toBe(502)
			expect(await db.select().from(voiceCalls)).toHaveLength(1)

			const deleted = await app.request(`/operator/calls/${callId}`, {
				method: 'DELETE',
				headers: { Authorization: `Bearer ${jwt}` },
			})
			expect(deleted.status).toBe(200)
			expect(await db.select().from(voiceCalls)).toHaveLength(0)
		})

		it('deletes the expected recording key when a deleted call has none', async () => {
			const callId = await startCall('late-recording')
			const db = await getTenantDb(orgId)
			const jwt = await operatorJwt('phone_calls', { canDelete: true })
			const remove = () =>
				app.request(`/operator/calls/${callId}`, {
					method: 'DELETE',
					headers: { Authorization: `Bearer ${jwt}` },
				})
			fetchSpy.mockResolvedValueOnce(new Response(null, { status: 500 }))
			expect((await remove()).status).toBe(502)
			expect(await db.select().from(voiceCalls)).toHaveLength(1)

			expect((await remove()).status).toBe(200)
			expect(fetchSpy).toHaveBeenLastCalledWith(
				`https://s3.example.test/recordings/voice-recordings/${orgId}/${callId}.ogg`,
				expect.objectContaining({ method: 'DELETE' }),
			)
			expect(await db.select().from(voiceCalls)).toHaveLength(0)
		})

		it('sweeps the expected recording key of expired calls once', async () => {
			const callId = await startCall('late-expired', {
				callerPhone: '+12125554444',
			})
			const db = await getTenantDb(orgId)
			await db
				.update(voiceCalls)
				.set({ transcriptExpiresAt: new Date(Date.now() - 1000) })
				.where(eq(voiceCalls.id, callId))

			expect(await (await purge()).json()).toMatchObject({
				recordingsDeleted: 1,
				transcriptsCleared: 1,
			})
			expect(fetchSpy).toHaveBeenCalledWith(
				`https://s3.example.test/recordings/voice-recordings/${orgId}/${callId}.ogg`,
				expect.objectContaining({ method: 'DELETE' }),
			)
			expect((await callRow(callId)).recordingSweptAt).toBeInstanceOf(Date)
			expect(await db.select().from(voiceRecordingDeletions)).toHaveLength(0)

			fetchSpy.mockClear()
			expect(await (await purge()).json()).toMatchObject({
				recordingsDeleted: 0,
			})
			expect(fetchSpy).not.toHaveBeenCalled()
		})

		it('does not sweep expected keys without storage credentials', async () => {
			for (const key of Object.keys(recordingEnv)) process.env[key] = ''
			const callId = await startCall('late-unconfigured')
			const db = await getTenantDb(orgId)
			await db
				.update(voiceCalls)
				.set({ transcriptExpiresAt: new Date(Date.now() - 1000) })
				.where(eq(voiceCalls.id, callId))
			expect(await (await purge()).json()).toMatchObject({
				recordingsPending: 0,
			})
			expect(await db.select().from(voiceRecordingDeletions)).toHaveLength(0)
			expect((await callRow(callId)).recordingSweptAt).toBeNull()
		})

		it('deletes queued recordings with bounded concurrency', async () => {
			const db = await getTenantDb(orgId)
			await db.insert(voiceRecordingDeletions).values(
				Array.from({ length: 20 }, (_, index) => ({
					recordingKey: `voice-recordings/${orgId}/queued-${index}.ogg`,
				})),
			)
			let inFlight = 0
			let maxInFlight = 0
			fetchSpy.mockImplementation(async () => {
				inFlight++
				maxInFlight = Math.max(maxInFlight, inFlight)
				await new Promise((resolve) => setTimeout(resolve, 2))
				inFlight--
				return new Response(null, { status: 204 })
			})
			expect(await (await purge()).json()).toMatchObject({
				recordingsDeleted: 20,
				recordingsDeferred: 0,
			})
			expect(maxInFlight).toBe(8)
			expect(await db.select().from(voiceRecordingDeletions)).toHaveLength(0)
		})

		it('leaves recordings for the next run when the purge runs out of time', async () => {
			const db = await getTenantDb(orgId)
			await db.insert(voiceRecordingDeletions).values(
				Array.from({ length: 20 }, (_, index) => ({
					recordingKey: `voice-recordings/${orgId}/slow-${index}.ogg`,
				})),
			)
			const realNow = Date.now.bind(Date)
			let elapsed = 0
			const clock = vi
				.spyOn(Date, 'now')
				.mockImplementation(() => realNow() + elapsed)
			// The first delete uses up the whole budget.
			fetchSpy.mockImplementation(async () => {
				elapsed += RECORDING_PURGE_BUDGET_MS
				return new Response(null, { status: 204 })
			})
			try {
				expect(await (await purge()).json()).toMatchObject({
					success: true,
					recordingsDeleted: 1,
					recordingsDeferred: 19,
				})
			} finally {
				clock.mockRestore()
			}
			expect(await db.select().from(voiceRecordingDeletions)).toHaveLength(19)

			fetchSpy.mockResolvedValue(new Response(null, { status: 204 }))
			expect(await (await purge()).json()).toMatchObject({
				recordingsDeleted: 19,
				recordingsDeferred: 0,
			})
			expect(await db.select().from(voiceRecordingDeletions)).toHaveLength(0)
		})

		it('deletes texted links past their grace period or their call retention', async () => {
			const db = await getTenantDb(orgId)
			const expiredCall = await startCall('handoff-expired')
			const liveCall = await startCall('handoff-live')
			await db
				.update(voiceCalls)
				.set({ transcriptExpiresAt: new Date(Date.now() - 1000) })
				.where(eq(voiceCalls.id, expiredCall))
			const day = 86_400_000
			const handoff = (callId: string, expiresAt: Date, tokenHash: string) => ({
				callId,
				tokenHash,
				path: '/book',
				payload: linkPayload,
				sentToPhone: '+12125551234',
				expiresAt,
			})
			await db
				.insert(voiceLinkHandoffs)
				.values([
					handoff(
						liveCall,
						new Date(Date.now() - (HANDOFF_GRACE_DAYS + 1) * day),
						'stale',
					),
					handoff(
						liveCall,
						new Date(Date.now() - (HANDOFF_GRACE_DAYS - 1) * day),
						'recent',
					),
					handoff(expiredCall, new Date(Date.now() + day), 'retention'),
				])

			expect(await (await purge()).json()).toMatchObject({
				handoffsDeleted: 2,
			})
			const remaining = await db.select().from(voiceLinkHandoffs)
			expect(remaining.map((row) => row.tokenHash)).toEqual(['recent'])
			expect(remaining[0]!.sentToPhone).toBe('+12125551234')
		})

		it('erases a caller by phone', async () => {
			const db = await getTenantDb(orgId)
			const [customer] = await db
				.insert(customers)
				.values({ name: 'Eve', phone: '+12125558888' })
				.returning({ id: customers.id })
			const byPhone = await startCall('erase-1', {
				callerPhone: '+12125558888',
			})
			const other = await startCall('erase-2', {
				callerPhone: '+12125559999',
			})
			await db
				.update(voiceCalls)
				.set({ recordingKey: 'voice-recordings/erase.ogg' })
				.where(eq(voiceCalls.id, byPhone))
			await internal('/api/voice/requests', {
				orgId,
				callId: other,
				type: 'callback',
				callerPhone: '+12125558888',
				details: { note: 'call me' },
			})

			const res = await command('/api/voice/erase', {
				orgId,
				phone: '+12125558888',
			})
			expect(await res.json()).toMatchObject({
				success: true,
				callsDeleted: 1,
				requestsDeleted: 1,
			})
			// The stored key, plus the expected key a late recording would use.
			expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([
				'https://s3.example.test/recordings/voice-recordings/erase.ogg',
				`https://s3.example.test/recordings/voice-recordings/${orgId}/${byPhone}.ogg`,
			])
			const remaining = await db.select().from(voiceCalls)
			expect(remaining.map((row) => row.id)).toEqual([other])
			expect(customer).toBeDefined()
		})

		it('lets operators who can delete erase a customer from the browser', async () => {
			const db = await getTenantDb(orgId)
			const [customer] = await db
				.insert(customers)
				.values({ name: 'Mo', phone: '+12125551010' })
				.returning({ id: customers.id })
			const theirCall = await startCall('erase-op-1', {
				callerPhone: '+12125551010',
			})
			const other = await startCall('erase-op-2', {
				callerPhone: '+12125552020',
			})
			await internal('/api/voice/requests', {
				orgId,
				callId: other,
				type: 'callback',
				callerPhone: '+12125551010',
				details: { note: 'call Mo' },
			})
			await internal('/api/voice/website-links', {
				orgId,
				callId: other,
				sendTo: '+12125551010',
			})
			// Storage is not configured, so the recording is queued, not lost.
			for (const key of Object.keys(recordingEnv)) process.env[key] = ''
			const recordingKey = `voice-recordings/${orgId}/${theirCall}.ogg`
			await db
				.update(voiceCalls)
				.set({ recordingKey })
				.where(eq(voiceCalls.id, theirCall))

			const erase = (body: unknown, jwt: string) =>
				app.request('/operator/calls/erase', {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${jwt}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify(body),
				})
			const reader = await operatorJwt('phone_calls')
			expect((await erase({ customerId: customer!.id }, reader)).status).toBe(
				403,
			)
			const editor = await operatorJwt('phone_calls', { canDelete: true })
			expect((await erase({}, editor)).status).toBe(400)

			const res = await erase({ customerId: customer!.id }, editor)
			expect(await res.json()).toEqual({
				success: true,
				callsDeleted: 1,
				requestsDeleted: 1,
				smsLogsDeleted: 1,
				recordingsQueued: 1,
			})
			expect((await db.select().from(voiceCalls)).map((row) => row.id)).toEqual(
				[other],
			)
			expect(await db.select().from(voiceCallRequests)).toHaveLength(0)
			expect(await db.select().from(voiceRecordingDeletions)).toEqual([
				expect.objectContaining({ recordingKey }),
			])
		})
	})

	describe('line verifications', () => {
		const verify = (body: Record<string, unknown>, token = internalToken) =>
			post('/api/voice/line-verifications', { orgId, ...body }, token)

		beforeEach(() => {
			process.env.TWILIO_ACCOUNT_SID = ''
			process.env.TWILIO_AUTH_TOKEN = ''
			process.env.TWILIO_FROM_NUMBER = ''
		})

		it('requires the internal token', async () => {
			const res = await verify(
				{ phone: '+12125550100', code: '123456', method: 'sms' },
				voiceToken,
			)
			expect(res.status).toBe(401)
		})

		it('texts the code and rate limits per phone', async () => {
			const body = { phone: '+12125550101', code: '123456', method: 'sms' }
			const res = await verify(body)
			expect(await res.json()).toEqual({ sent: true })
			expect(vi.mocked(sendSms)).toHaveBeenCalledWith({
				to: '+12125550101',
				message: `Your ${brand.name} verification code is 123456`,
			})
			for (let attempt = 1; attempt < 5; attempt++) {
				expect((await verify(body)).status).toBe(200)
			}
			const limited = await verify(body)
			expect(limited.status).toBe(429)
			expect(await limited.json()).toEqual({ error: 'rate_limit_exceeded' })
		})

		it('keeps the per-phone limit in the database, not the process', async () => {
			const db = await getTenantDb(orgId)
			const phone = '+12125550105'
			const attempt = (createdAt: Date) => ({
				toPhone: phone,
				method: 'sms' as const,
				status: 'sent' as const,
				createdAt,
			})
			// Logged by an earlier process: four this hour, more before it.
			await db
				.insert(voiceLineVerifications)
				.values([
					...Array.from({ length: 4 }, () =>
						attempt(new Date(Date.now() - 10 * 60_000)),
					),
					attempt(new Date(Date.now() - 2 * 3_600_000)),
				])
			const body = { phone, code: '123456', method: 'call' }
			const info = vi.spyOn(console, 'info').mockImplementation(() => {})
			expect((await verify(body)).status).toBe(200)
			const limited = await verify(body)
			expect(limited.status).toBe(429)
			expect(await limited.json()).toEqual({ error: 'rate_limit_exceeded' })
			// Other lines of the same org are not affected.
			expect((await verify({ ...body, phone: '+12125550106' })).status).toBe(
				200,
			)
			info.mockRestore()
			const logs = await db
				.select()
				.from(voiceLineVerifications)
				.where(eq(voiceLineVerifications.toPhone, phone))
			expect(logs).toHaveLength(6)
		})

		it('logs the code for voice calls without Twilio in dev', async () => {
			const info = vi.spyOn(console, 'info').mockImplementation(() => {})
			const res = await verify({
				phone: '+12125550102',
				code: '654321',
				method: 'call',
			})
			expect(res.status).toBe(200)
			expect(info).toHaveBeenCalledWith(expect.stringContaining('654321'))
			info.mockRestore()
		})

		it('rejects invalid codes and the KSA node', async () => {
			expect(
				(
					await verify({
						phone: '+12125550103',
						code: '12345',
						method: 'sms',
					})
				).status,
			).toBe(400)
			process.env.DATA_REGION = 'ksa'
			try {
				const res = await verify({
					phone: '+12125550103',
					code: '123456',
					method: 'sms',
				})
				expect(res.status).toBe(409)
			} finally {
				process.env.DATA_REGION = 'us'
			}
		})

		it.each(['+447700900123', '+18765550123', '+19005550123', '+12115550123'])(
			'only sends codes to US or Canadian numbers (%s)',
			async (phone) => {
				const info = vi.spyOn(console, 'info').mockImplementation(() => {})
				for (const method of ['sms', 'call']) {
					const res = await verify({ phone, code: '123456', method })
					expect(res.status).toBe(400)
					expect(await res.json()).toEqual({ error: 'not_allowed_number' })
				}
				expect(vi.mocked(sendSms)).not.toHaveBeenCalled()
				expect(info).not.toHaveBeenCalled()
				info.mockRestore()
			},
		)

		it('requires an organization in this region', async () => {
			const body = { phone: '+12125550104', code: '123456', method: 'sms' }
			const missingOrg = await post(
				'/api/voice/line-verifications',
				body,
				internalToken,
			)
			expect(missingOrg.status).toBe(400)
			vi.mocked(findActiveOrganizationById).mockResolvedValueOnce({
				...org!,
				dataRegion: 'ksa',
			})
			expect((await verify(body)).status).toBe(404)
			expect(vi.mocked(sendSms)).not.toHaveBeenCalled()
		})

		it('caps codes per organization per day, counting failed sends', async () => {
			vi.mocked(sendSms).mockRejectedValueOnce(new Error('twilio down'))
			const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
			const phone = (index: number) =>
				`+1212555${String(300 + index).padStart(4, '0')}`
			const first = await verify({
				phone: phone(0),
				code: '123456',
				method: 'sms',
			})
			expect(first.status).toBe(502)
			const results = await Promise.all(
				Array.from(
					{ length: MAX_LINE_VERIFICATIONS_PER_ORG_PER_DAY + 2 },
					(_, index) =>
						verify({ phone: phone(index + 1), code: '123456', method: 'sms' }),
				),
			)
			const statuses = results.map((res) => res.status)
			expect(statuses.filter((status) => status === 200)).toHaveLength(
				MAX_LINE_VERIFICATIONS_PER_ORG_PER_DAY - 1,
			)
			expect(statuses.filter((status) => status === 429)).toHaveLength(3)
			const limited = results.find((res) => res.status === 429)!
			expect(await limited.json()).toEqual({ error: 'daily_limit_exceeded' })
			const db = await getTenantDb(orgId)
			const logs = await db.select().from(voiceLineVerifications)
			expect(logs).toHaveLength(MAX_LINE_VERIFICATIONS_PER_ORG_PER_DAY)
			expect(logs.filter((log) => log.status === 'failed')).toHaveLength(1)
			errorSpy.mockRestore()
		})
	})
})
