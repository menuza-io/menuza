import { faker } from '@faker-js/faker'
import {
	db,
	eq,
	Organization,
	PhoneAgent,
	PhoneAgentFlowVersion,
	PhoneAgentNumber,
	PlatformPhoneNumber,
} from '@repo/database'
import {
	createDefaultFlowGraph,
	DEFAULT_PHONE_AGENT_SETTINGS,
	type PhoneAgentPassthrough,
	type PhoneAgentSettings,
} from '@repo/phone-agent'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	PhoneLineVerificationError,
	sendPhoneLineVerification,
} from '#app/utils/tenant-api.server.ts'
import {
	addPhoneNumber,
	getPhoneAgent,
	removePhoneNumber,
	sendLineVerificationCode,
} from './phone-agent.server.ts'
import { buildRuntimeConfig } from './runtime-config.server.ts'

// Run against the general vertical, whichever one this deployment picks.
vi.mock('./vertical.ts', async () => {
	const { generalVertical } = await import('@repo/phone-agent')
	return {
		phoneAgentVertical: generalVertical,
		businessMessageVariables: (business: string) => ({ business }),
	}
})
vi.mock('./vertical.server.ts', async () => {
	const { generalServerVertical } = await import('./vertical-general.server.ts')
	return { phoneAgentServerVertical: generalServerVertical }
})

vi.mock('#app/utils/tenant-api.server.ts', async (importOriginal) => {
	const actual = await importOriginal<{
		PhoneLineVerificationError: typeof PhoneLineVerificationError
	}>()
	return {
		PhoneLineVerificationError: actual.PhoneLineVerificationError,
		sendPhoneLineVerification: vi.fn(),
	}
})

function uniqueUsNumber() {
	return `+14155${faker.string.numeric(6)}`
}

async function setup() {
	const [organization] = await db
		.insert(Organization)
		.values({
			name: faker.company.name(),
			slug: `phone-${Date.now()}-${faker.string.alphanumeric(6).toLowerCase()}`,
		})
		.returning()
	const businessLine = uniqueUsNumber()
	const [platformNumber] = await db
		.insert(PlatformPhoneNumber)
		.values({
			e164: uniqueUsNumber(),
			assignedOrganizationId: organization!.id,
			assignedAt: new Date(),
		})
		.returning()
	return {
		orgId: organization!.id,
		businessLine,
		platformNumber: platformNumber!,
	}
}

async function setSettings(orgId: string, patch: Partial<PhoneAgentSettings>) {
	await getPhoneAgent(orgId)
	await db
		.update(PhoneAgent)
		.set({
			settings: JSON.stringify({ ...DEFAULT_PHONE_AGENT_SETTINGS, ...patch }),
		})
		.where(eq(PhoneAgent.organizationId, orgId))
}

async function connectForwardedLine(input: Awaited<ReturnType<typeof setup>>) {
	const [row] = await db
		.insert(PhoneAgentNumber)
		.values({
			organizationId: input.orgId,
			scopeId: null,
			platformNumberId: input.platformNumber.id,
			e164: input.platformNumber.e164,
			mode: 'forwarding',
			forwardedFrom: input.businessLine,
			isActive: true,
			verifiedAt: new Date(),
		})
		.returning()
	return row!
}

function passthroughOf(result: Awaited<ReturnType<typeof buildRuntimeConfig>>) {
	if (result.ok) throw new Error('Expected a failed lookup')
	return result.passthrough as PhoneAgentPassthrough
}

describe('addPhoneNumber', () => {
	beforeEach(() => {
		vi.mocked(sendPhoneLineVerification).mockReset().mockResolvedValue()
	})

	it('connects an assigned platform number', async () => {
		const input = await setup()
		const result = await addPhoneNumber(input.orgId, {
			scopeId: null,
			platformNumberId: input.platformNumber.id,
			mode: 'dedicated',
		})
		expect(result).toEqual({ ok: true })
		const [row] = await db
			.select()
			.from(PhoneAgentNumber)
			.where(eq(PhoneAgentNumber.platformNumberId, input.platformNumber.id))
		expect(row).toMatchObject({
			organizationId: input.orgId,
			e164: input.platformNumber.e164,
			mode: 'dedicated',
			isActive: true,
			verificationAttempts: 0,
		})
		expect(row!.createdAt).toBeInstanceOf(Date)

		await removePhoneNumber(input.orgId, row!.id)
		const remaining = await db
			.select()
			.from(PhoneAgentNumber)
			.where(eq(PhoneAgentNumber.id, row!.id))
		expect(remaining).toEqual([])
	})

	it('refuses a number that is no longer assigned', async () => {
		const input = await setup()
		await db
			.update(PlatformPhoneNumber)
			.set({ assignedOrganizationId: null })
			.where(eq(PlatformPhoneNumber.id, input.platformNumber.id))
		const result = await addPhoneNumber(input.orgId, {
			scopeId: null,
			platformNumberId: input.platformNumber.id,
			mode: 'dedicated',
		})
		expect(result).toEqual({
			ok: false,
			error: 'Choose one of the numbers assigned to your business.',
		})
	})

	it('refuses a forwarded line outside the US and Canada', async () => {
		const input = await setup()
		const result = await addPhoneNumber(input.orgId, {
			scopeId: null,
			platformNumberId: input.platformNumber.id,
			mode: 'forwarding',
			forwardedFrom: '+18765550123',
		})
		expect(result.ok).toBe(false)
		expect(!result.ok && result.error).toContain('US or Canadian')
	})

	it('refuses a line the published phone menu transfers to', async () => {
		const input = await setup()
		const graph = createDefaultFlowGraph()
		graph.nodes = graph.nodes.map((node) =>
			node.type === 'transfer'
				? { ...node, data: { ...node.data, phone: input.businessLine } }
				: node,
		)
		await getPhoneAgent(input.orgId)
		const [version] = await db
			.insert(PhoneAgentFlowVersion)
			.values({
				organizationId: input.orgId,
				version: 1,
				graph: JSON.stringify(graph),
				status: 'published',
				publishedAt: new Date(),
			})
			.returning()
		await db
			.update(PhoneAgent)
			.set({ publishedFlowVersionId: version!.id })
			.where(eq(PhoneAgent.organizationId, input.orgId))

		const result = await addPhoneNumber(input.orgId, {
			scopeId: null,
			platformNumberId: input.platformNumber.id,
			mode: 'forwarding',
			forwardedFrom: input.businessLine,
		})
		expect(result.ok).toBe(false)
		expect(!result.ok && result.error).toContain('published phone menu')
	})
})

describe('sendLineVerificationCode', () => {
	beforeEach(() => {
		vi.mocked(sendPhoneLineVerification).mockReset().mockResolvedValue()
	})

	it('never texts a line outside the US and Canada', async () => {
		const input = await setup()
		const row = await connectForwardedLine(input)
		await db
			.update(PhoneAgentNumber)
			.set({ forwardedFrom: '+442071234567', verifiedAt: null })
			.where(eq(PhoneAgentNumber.id, row.id))
		const result = await sendLineVerificationCode(input.orgId, row.id, 'sms')
		expect(result.ok).toBe(false)
		expect(sendPhoneLineVerification).not.toHaveBeenCalled()
	})

	it("sends the org id and explains tenant-api's daily limit", async () => {
		const input = await setup()
		const row = await connectForwardedLine(input)
		await db
			.update(PhoneAgentNumber)
			.set({ verifiedAt: null, verificationSentAt: null })
			.where(eq(PhoneAgentNumber.id, row.id))
		vi.mocked(sendPhoneLineVerification).mockRejectedValueOnce(
			new PhoneLineVerificationError(429, 'daily_limit_exceeded'),
		)
		vi.spyOn(console, 'error').mockImplementation(() => {})
		const result = await sendLineVerificationCode(input.orgId, row.id, 'sms')
		expect(sendPhoneLineVerification).toHaveBeenCalledWith(
			expect.objectContaining({ orgId: input.orgId, method: 'sms' }),
		)
		expect(!result.ok && result.error).toContain('today')
	})

	it('caps verification sends per organization each day', async () => {
		const input = await setup()
		const row = await connectForwardedLine(input)
		const unverify = () =>
			db
				.update(PhoneAgentNumber)
				.set({ verifiedAt: null, verificationSentAt: null })
				.where(eq(PhoneAgentNumber.id, row.id))
		for (let index = 0; index < 10; index++) {
			await unverify()
			expect(
				await sendLineVerificationCode(input.orgId, row.id, 'call'),
			).toEqual({ ok: true })
		}
		await unverify()
		const blocked = await sendLineVerificationCode(input.orgId, row.id, 'call')
		expect(blocked.ok).toBe(false)
		expect(!blocked.ok && blocked.error).toContain('today')
		expect(sendPhoneLineVerification).toHaveBeenCalledTimes(10)
	})

	it('sends only once when requests race past the cooldown', async () => {
		const input = await setup()
		const row = await connectForwardedLine(input)
		await db
			.update(PhoneAgentNumber)
			.set({ verifiedAt: null, verificationSentAt: null })
			.where(eq(PhoneAgentNumber.id, row.id))
		const results = await Promise.all(
			Array.from({ length: 5 }, () =>
				sendLineVerificationCode(input.orgId, row.id, 'sms'),
			),
		)
		expect(results.filter((result) => result.ok)).toHaveLength(1)
		expect(sendPhoneLineVerification).toHaveBeenCalledTimes(1)
		const blocked = results.find((result) => !result.ok)
		expect(!blocked?.ok && blocked?.error).toContain('Wait 30 seconds')
	})

	it('allows a resend once the cooldown has passed', async () => {
		const input = await setup()
		const row = await connectForwardedLine(input)
		await db
			.update(PhoneAgentNumber)
			.set({
				verifiedAt: null,
				verificationSentAt: new Date(Date.now() - 31_000),
			})
			.where(eq(PhoneAgentNumber.id, row.id))
		expect(await sendLineVerificationCode(input.orgId, row.id, 'sms')).toEqual({
			ok: true,
		})
		const again = await sendLineVerificationCode(input.orgId, row.id, 'sms')
		expect(!again.ok && again.error).toContain('Wait 30 seconds')
		expect(sendPhoneLineVerification).toHaveBeenCalledTimes(1)
	})

	it('gives the slot back when the daily budget refuses the send', async () => {
		const input = await setup()
		const row = await connectForwardedLine(input)
		const earlier = new Date(Date.now() - 60_000)
		const unverify = (sentAt: Date | null) =>
			db
				.update(PhoneAgentNumber)
				.set({ verifiedAt: null, verificationSentAt: sentAt })
				.where(eq(PhoneAgentNumber.id, row.id))
		for (let index = 0; index < 10; index++) {
			await unverify(null)
			await sendLineVerificationCode(input.orgId, row.id, 'call')
		}
		await unverify(earlier)
		const blocked = await sendLineVerificationCode(input.orgId, row.id, 'call')
		expect(!blocked.ok && blocked.error).toContain('today')
		const [after] = await db
			.select({ verificationSentAt: PhoneAgentNumber.verificationSentAt })
			.from(PhoneAgentNumber)
			.where(eq(PhoneAgentNumber.id, row.id))
		expect(after?.verificationSentAt?.getTime()).toBe(earlier.getTime())
	})
})

describe('buildRuntimeConfig for a called number', () => {
	it('stops answering once the number is unassigned', async () => {
		const input = await setup()
		await connectForwardedLine(input)
		await setSettings(input.orgId, { enabled: true })
		await db
			.update(PlatformPhoneNumber)
			.set({ assignedOrganizationId: null })
			.where(eq(PlatformPhoneNumber.id, input.platformNumber.id))
		const result = await buildRuntimeConfig({
			kind: 'number',
			calledNumber: input.platformNumber.e164,
		})
		expect(result).toMatchObject({ ok: false, status: 404 })
	})

	it('never sends a paused call back to the forwarded line', async () => {
		const input = await setup()
		await connectForwardedLine(input)
		const escalationPhone = uniqueUsNumber()
		await setSettings(input.orgId, {
			enabled: false,
			escalationPhone,
			languages: ['es', 'en'],
			phrases: [
				{
					key: 'calling_disabled',
					language: 'es',
					text: 'Un momento, le paso con {business}.',
				},
			],
		})
		const passthrough = passthroughOf(
			await buildRuntimeConfig({
				kind: 'number',
				calledNumber: input.platformNumber.e164,
			}),
		)
		expect(passthrough.phone).toBe(escalationPhone)
		expect(passthrough.language).toBe('es')
		expect(passthrough.message).toMatch(/^Un momento, le paso con .+\.$/u)
		expect(passthrough.message).not.toContain('{business}')
		expect(passthrough.agentLines).toEqual(
			expect.arrayContaining([input.platformNumber.e164, input.businessLine]),
		)
	})

	it('hangs up rather than loop when no safe number exists', async () => {
		const input = await setup()
		await connectForwardedLine(input)
		await setSettings(input.orgId, { enabled: false })
		const passthrough = passthroughOf(
			await buildRuntimeConfig({
				kind: 'number',
				calledNumber: input.platformNumber.e164,
			}),
		)
		expect(passthrough.phone).toBeNull()
	})

	it('keeps the fallback phone off the agent lines', async () => {
		const input = await setup()
		await connectForwardedLine(input)
		const escalationPhone = uniqueUsNumber()
		await setSettings(input.orgId, { enabled: true, escalationPhone })
		const result = await buildRuntimeConfig({
			kind: 'number',
			calledNumber: input.platformNumber.e164,
		})
		if (!result.ok) throw new Error(result.error)
		expect(result.config.fallbackPhone).toBe(escalationPhone)
		expect(result.config.agentLines).toEqual(
			expect.arrayContaining([input.platformNumber.e164, input.businessLine]),
		)
	})
})
