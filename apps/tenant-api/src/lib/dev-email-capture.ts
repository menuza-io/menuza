import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { getOciEmailConfig } from '@repo/email'

/**
 * Development-only email sink for the Node runtime.
 *
 * `sendTenantEmail` only logs (`[OCI EMAIL MOCK]`) when OCI email is not
 * configured, so a developer cannot see what a guest would receive. With
 * `DEV_EMAIL_CAPTURE_DIR` set, each such message is also written as a JSON
 * file. It never redirects real mail: it is inactive in production and
 * whenever OCI email is configured. The Workers entry never imports this
 * file (it registers itself from `src/index.ts`), so a Durable Object build
 * has no filesystem sink at all.
 */

export type DevEmailRecord = {
	to: string
	from: string
	subject: string
	html: string
	text: string
	meta: { orgId?: string; messageKind?: string; messageId?: string }
}

export function devEmailCaptureDir(
	env: Record<string, string | undefined> = process.env,
): string | null {
	const dir = env.DEV_EMAIL_CAPTURE_DIR?.trim()
	return dir ? dir : null
}

export function isDevEmailCaptureOn(
	options: {
		env?: Record<string, string | undefined>
		ociConfigured?: boolean
	} = {},
): boolean {
	const env = options.env ?? process.env
	if (!devEmailCaptureDir(env)) return false
	if (env.NODE_ENV === 'production') return false
	const ociConfigured = options.ociConfigured ?? getOciEmailConfig() !== null
	return !ociConfigured
}

function stamp(at: Date): string {
	return at.toISOString().replace(/[-:]/g, '').replace('.', '').replace('Z', '')
}

/** `20260101T120000123` style name, sortable by capture time. */
export async function captureDevEmail(
	record: DevEmailRecord,
	options: {
		region?: 'us' | 'ksa' | null
		now?: Date
		env?: Record<string, string | undefined>
	} = {},
): Promise<string | null> {
	const env = options.env ?? process.env
	const dir = devEmailCaptureDir(env)
	if (!dir || !isDevEmailCaptureOn({ env })) return null
	const now = options.now ?? new Date()
	const id = randomUUID()
	const target = path.resolve(dir)
	await mkdir(target, { recursive: true })
	const file = path.join(target, `${stamp(now)}-${id}.json`)
	await writeFile(
		file,
		JSON.stringify(
			{
				id,
				capturedAt: now.toISOString(),
				source: 'tenant-api',
				region: options.region ?? null,
				to: record.to,
				from: record.from,
				subject: record.subject,
				html: record.html,
				text: record.text,
				meta: record.meta,
			},
			null,
			2,
		),
		'utf8',
	)
	return file
}
