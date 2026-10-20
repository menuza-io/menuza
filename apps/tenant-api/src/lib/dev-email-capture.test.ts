import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest'

const ociMock = vi.hoisted(() => ({ send: vi.fn() }))

vi.mock('@repo/email', async (importOriginal) => ({
	...(await importOriginal<typeof import('@repo/email')>()),
	sendOciEmail: ociMock.send,
}))

import {
	captureDevEmail,
	devEmailCaptureDir,
	isDevEmailCaptureOn,
	type DevEmailRecord,
} from './dev-email-capture.ts'
import { sendTenantEmail, setTenantEmailDevCapture } from './tenant-email.ts'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-email-capture-'))

const RECORD: DevEmailRecord = {
	to: 'guest@example.com',
	from: 'noreply@dev.example.test',
	subject: 'Your order at Acme is confirmed',
	html: '<p>Hello &amp; welcome</p>',
	text: 'Hello & welcome',
	meta: { orgId: 'org_1', messageKind: 'confirmation', messageId: 'msg_1' },
}

let counter = 0
function freshDir(...segments: string[]) {
	return path.join(ROOT, `case-${++counter}`, ...segments)
}

function filesIn(dir: string) {
	return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []
}

afterAll(() => {
	fs.rmSync(ROOT, { recursive: true, force: true })
})

describe('devEmailCaptureDir and isDevEmailCaptureOn', () => {
	it('is off without a directory', () => {
		expect(devEmailCaptureDir({})).toBeNull()
		expect(devEmailCaptureDir({ DEV_EMAIL_CAPTURE_DIR: '   ' })).toBeNull()
		expect(isDevEmailCaptureOn({ env: {}, ociConfigured: false })).toBe(false)
	})

	it('trims the configured directory', () => {
		expect(
			devEmailCaptureDir({ DEV_EMAIL_CAPTURE_DIR: '  .dev-mail/us ' }),
		).toBe('.dev-mail/us')
	})

	it('is on only outside production and only while OCI email is not configured', () => {
		const env = { DEV_EMAIL_CAPTURE_DIR: '/tmp/x' }
		expect(isDevEmailCaptureOn({ env, ociConfigured: false })).toBe(true)
		expect(isDevEmailCaptureOn({ env, ociConfigured: true })).toBe(false)
		expect(
			isDevEmailCaptureOn({
				env: { ...env, NODE_ENV: 'production' },
				ociConfigured: false,
			}),
		).toBe(false)
		expect(
			isDevEmailCaptureOn({
				env: { ...env, NODE_ENV: 'test' },
				ociConfigured: false,
			}),
		).toBe(true)
	})
})

describe('captureDevEmail', () => {
	it('writes one JSON file per message under the configured directory', async () => {
		const dir = freshDir('us')
		const now = new Date('2031-06-14T19:30:00.123Z')
		const file = await captureDevEmail(RECORD, {
			region: 'us',
			now,
			env: { DEV_EMAIL_CAPTURE_DIR: dir },
		})
		expect(file).not.toBeNull()
		expect(path.dirname(file!)).toBe(path.resolve(dir))
		expect(path.basename(file!)).toMatch(
			/^20310614T193000123-[0-9a-f-]{36}\.json$/,
		)
		const saved = JSON.parse(fs.readFileSync(file!, 'utf8'))
		expect(saved).toMatchObject({
			source: 'tenant-api',
			region: 'us',
			capturedAt: '2031-06-14T19:30:00.123Z',
			to: RECORD.to,
			from: RECORD.from,
			subject: RECORD.subject,
			html: RECORD.html,
			text: RECORD.text,
			meta: RECORD.meta,
		})
		expect(typeof saved.id).toBe('string')
		expect(filesIn(dir)).toHaveLength(1)
	})

	it('keeps the us and ksa nodes in separate directories and records the region', async () => {
		const us = freshDir('us')
		const ksa = freshDir('ksa')
		const usFile = await captureDevEmail(RECORD, {
			region: 'us',
			env: { DEV_EMAIL_CAPTURE_DIR: us },
		})
		const ksaFile = await captureDevEmail(RECORD, {
			region: 'ksa',
			env: { DEV_EMAIL_CAPTURE_DIR: ksa },
		})
		expect(JSON.parse(fs.readFileSync(usFile!, 'utf8')).region).toBe('us')
		expect(JSON.parse(fs.readFileSync(ksaFile!, 'utf8')).region).toBe('ksa')
		expect(filesIn(us)).toHaveLength(1)
		expect(filesIn(ksa)).toHaveLength(1)
		const none = await captureDevEmail(RECORD, {
			env: { DEV_EMAIL_CAPTURE_DIR: freshDir() },
		})
		expect(JSON.parse(fs.readFileSync(none!, 'utf8')).region).toBeNull()
	})

	it('creates nested directories and gives two messages in the same millisecond different files', async () => {
		const dir = freshDir('a', 'b', 'c')
		const now = new Date('2031-01-01T00:00:00.000Z')
		const env = { DEV_EMAIL_CAPTURE_DIR: dir }
		const first = await captureDevEmail(RECORD, { now, env })
		const second = await captureDevEmail(RECORD, { now, env })
		expect(first).not.toBe(second)
		expect(filesIn(dir)).toHaveLength(2)
	})

	it('sorts by capture time', async () => {
		const dir = freshDir()
		const env = { DEV_EMAIL_CAPTURE_DIR: dir }
		await captureDevEmail(RECORD, {
			now: new Date('2031-03-01T10:00:00Z'),
			env,
		})
		await captureDevEmail(RECORD, {
			now: new Date('2031-01-01T10:00:00Z'),
			env,
		})
		await captureDevEmail(RECORD, {
			now: new Date('2031-02-01T10:00:00Z'),
			env,
		})
		const months = filesIn(dir).map((name) => name.slice(4, 6))
		expect(months).toEqual(['01', '02', '03'])
	})

	it('writes nothing without a directory, in production, or when OCI is configured', async () => {
		const dir = freshDir()
		expect(await captureDevEmail(RECORD, { env: {} })).toBeNull()
		expect(
			await captureDevEmail(RECORD, {
				env: { DEV_EMAIL_CAPTURE_DIR: dir, NODE_ENV: 'production' },
			}),
		).toBeNull()
		expect(filesIn(dir)).toEqual([])
		expect(fs.existsSync(dir)).toBe(false)
	})
})

describe('sendTenantEmail capture hook', () => {
	const sink = vi.fn()

	beforeEach(() => {
		ociMock.send.mockReset()
		sink.mockReset()
		sink.mockResolvedValue(undefined)
		setTenantEmailDevCapture(sink)
	})

	afterEach(() => {
		setTenantEmailDevCapture(null)
	})

	const mail = {
		to: 'guest@example.com',
		subject: 'Hello',
		html: '<p>Hi</p>',
		text: 'Hi',
	}

	it('captures a message that the unconfigured mock transport skipped, with ids only in meta', async () => {
		ociMock.send.mockResolvedValue({
			status: 'skipped',
			data: { mock: true, messageId: 'mock-1' },
		})
		const result = await sendTenantEmail({
			...mail,
			capture: { orgId: 'org_1', messageKind: 'confirmation', messageId: 'm1' },
		})
		expect(result.status).toBe('skipped')
		expect(sink).toHaveBeenCalledTimes(1)
		const record = sink.mock.calls[0]![0]
		expect(record).toEqual({
			to: 'guest@example.com',
			from: 'noreply@dev.example.test',
			subject: 'Hello',
			html: '<p>Hi</p>',
			text: 'Hi',
			meta: { orgId: 'org_1', messageKind: 'confirmation', messageId: 'm1' },
		})
		expect(Object.keys(record.meta).sort()).toEqual([
			'messageId',
			'messageKind',
			'orgId',
		])
		expect(ociMock.send.mock.calls[0]![0].messageId).toBe('m1')
	})

	it('prefers an explicit from address and falls back to the context for ids', async () => {
		ociMock.send.mockResolvedValue({
			status: 'skipped',
			data: { mock: true, messageId: 'mock-2' },
		})
		await sendTenantEmail({
			...mail,
			from: 'host@acme.test',
			context: { orgId: 'org_ctx', messageId: 'ctx_msg' },
		})
		const record = sink.mock.calls[0]![0]
		expect(record.from).toBe('host@acme.test')
		expect(record.meta).toEqual({
			orgId: 'org_ctx',
			messageKind: undefined,
			messageId: 'ctx_msg',
		})
	})

	it('does not capture a message that was really sent or that failed', async () => {
		ociMock.send.mockResolvedValueOnce({
			status: 'success',
			data: { messageId: 'oci-1' },
		})
		await sendTenantEmail(mail)
		ociMock.send.mockResolvedValueOnce({
			status: 'error',
			error: { message: 'nope', statusCode: 500 },
		})
		await sendTenantEmail(mail)
		expect(sink).not.toHaveBeenCalled()
	})

	it('does not capture when no sink is registered (the Workers entry)', async () => {
		setTenantEmailDevCapture(null)
		ociMock.send.mockResolvedValue({
			status: 'skipped',
			data: { mock: true, messageId: 'mock-3' },
		})
		await expect(sendTenantEmail(mail)).resolves.toMatchObject({
			status: 'skipped',
		})
		expect(sink).not.toHaveBeenCalled()
	})

	it('never fails a send because the capture sink threw', async () => {
		ociMock.send.mockResolvedValue({
			status: 'skipped',
			data: { mock: true, messageId: 'mock-4' },
		})
		sink.mockRejectedValue(new Error('disk full'))
		await expect(sendTenantEmail(mail)).resolves.toMatchObject({
			status: 'skipped',
		})
		expect(sink).toHaveBeenCalledTimes(1)
	})

	it('writes the captured message to a temp directory end to end', async () => {
		const dir = freshDir('us')
		setTenantEmailDevCapture((record) =>
			captureDevEmail(record, {
				region: 'us',
				env: { DEV_EMAIL_CAPTURE_DIR: dir },
			}),
		)
		ociMock.send.mockResolvedValue({
			status: 'skipped',
			data: { mock: true, messageId: 'mock-5' },
		})
		await sendTenantEmail({
			...mail,
			capture: { orgId: 'org_1', messageKind: 'reminder', messageId: 'm5' },
		})
		const files = filesIn(dir)
		expect(files).toHaveLength(1)
		const saved = JSON.parse(fs.readFileSync(path.join(dir, files[0]!), 'utf8'))
		expect(saved.subject).toBe('Hello')
		expect(saved.meta.messageKind).toBe('reminder')
		expect(saved.region).toBe('us')
	})
})
