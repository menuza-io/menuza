import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import { type Context } from 'hono'
import {
	parsePrintRef,
	printerPasswordHashMessage,
	readPrinterPassword,
} from '@repo/common/print-devices'
import {
	getTenantDb,
	printDevices,
	type PrintDevice,
	type TenantDatabase,
} from '@repo/tenant-db'
import { hmacHash } from './secrets.ts'

/**
 * Cloud printer principal. A printer is addressed by the public ref in the URL
 * it polls (`<orgId>.<printerId>`) and proves itself with a short password only
 * it holds; only a keyed hash of the password is stored. The credential
 * authorizes polling for, fetching and acknowledging that one printer's jobs and
 * nothing else: it is never accepted on operator, terminal or kiosk routes, and
 * their credentials are never accepted here.
 *
 * Order: ref shape, the organization's database, the printer row, the keyed
 * hash (constant time), revocation. An unknown printer and a wrong password
 * answer the same `invalid_printer`, so a ref reveals nothing.
 */
const NO_STORE = { 'Cache-Control': 'private, no-store' }

export function printError(
	status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 503,
	error: string,
) {
	return Response.json({ error }, { status, headers: NO_STORE })
}

export const hashPrinterPassword = (ref: string, password: string): string =>
	hmacHash(printerPasswordHashMessage(ref, password))

function hashesMatch(left: string, right: string): boolean {
	const a = Buffer.from(left, 'utf8')
	const b = Buffer.from(right, 'utf8')
	return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export type PrinterAuth = {
	orgId: string
	device: PrintDevice
	db: TenantDatabase
}

export async function authenticatePrinter(
	c: Context,
	ref: string,
): Promise<{ printer: PrinterAuth } | { error: Response }> {
	const parsed = parsePrintRef(ref)
	const password = readPrinterPassword(c.req.header('Authorization'))
	if (!parsed || !password) return { error: printError(401, 'invalid_printer') }
	let db: TenantDatabase
	try {
		db = await getTenantDb(parsed.orgId)
	} catch {
		return { error: printError(401, 'invalid_printer') }
	}
	const [device] = await db
		.select()
		.from(printDevices)
		.where(eq(printDevices.id, parsed.printerId))
		.limit(1)
	let presented: string
	try {
		presented = hashPrinterPassword(ref, password)
	} catch {
		return { error: printError(503, 'service_unavailable') }
	}
	if (!device || !hashesMatch(presented, device.secretHash)) {
		return { error: printError(401, 'invalid_printer') }
	}
	if (device.revokedAt !== null) {
		return { error: printError(401, 'printer_revoked') }
	}
	return { printer: { orgId: parsed.orgId, device, db } }
}
