import { Hono, type Context } from 'hono'
import { type PrintJob } from '@repo/tenant-db'
import {
	epsonPrintRequest,
	parseEpsonForm,
	parseStarPoll,
	renderEpsonXml,
	renderStarPrnt,
	starAckOk,
	starPollResponse,
	STAR_MEDIA_TYPE,
} from '@repo/common/print-protocols'
import { readPrinterRoutes } from '@repo/common/print-devices'
import { type TicketDoc } from '@repo/common/print-ticket'
import { authenticatePrinter, printError } from '../lib/print-auth.ts'
import { printingEnabled } from '../lib/print-switches.ts'
import { prepareForPrinter } from '../lib/print-raster.ts'
import {
	acknowledgeJob,
	claimNextJob,
	jobToFetch,
	recordPoll,
} from '../services/print-service.ts'

/**
 * Printer-facing routes (#117): Star CloudPRNT and Epson Server Direct Print,
 * polled by the printer itself. The URL carries the public printer ref
 * (`/print/<orgId>.<printerId>/...`) and the printer's password rides in HTTP
 * Basic or Bearer; a printer can only see, fetch and finish its own jobs.
 *
 * Star prints on the URL it polls: its job fetch is a GET and its
 * acknowledgement a DELETE on the same path, with `token` (the job) and `code`
 * (the result) in the query. The same exchanges are also served at
 * `/print/<ref>/jobs/<id>`.
 *
 * Responses are `no-store`. While the node kill switch or the organization flag
 * is off, every poll answers "no job" and nothing is handed out.
 */
export const printRoutes = new Hono()

const NO_STORE = { 'Cache-Control': 'private, no-store' }
const MAX_BODY = 64 * 1024

async function readText(c: Context): Promise<string | null> {
	const declared = Number(c.req.header('content-length') ?? 0)
	if (declared > MAX_BODY) return null
	const text = await c.req.text()
	return text.length > MAX_BODY ? null : text
}

/** The data a printer prints for a job: the document in its protocol, pictures drawn for Arabic where needed. */
async function renderJob(
	job: PrintJob,
	device: { protocol: string; widthMm: number; routes: unknown },
) {
	const payload = job.payload as TicketDoc
	const routes = readPrinterRoutes(device.routes)
	const prepared = await prepareForPrinter(
		payload,
		routes,
		device.widthMm === 58 ? 58 : 80,
	)
	return prepared.doc
}

const refOf = (c: Context) => c.req.param('ref') ?? ''

printRoutes.post('/:ref/poll', async (c) => {
	const auth = await authenticatePrinter(c, refOf(c))
	if ('error' in auth) return auth.error
	const { device, db, orgId } = auth.printer
	const contentType = (c.req.header('content-type') ?? '').toLowerCase()
	const text = await readText(c)
	if (text === null) return printError(413, 'too_large')
	const live = await printingEnabled(orgId)

	if (contentType.includes('application/x-www-form-urlencoded')) {
		if (device.protocol !== 'epson_sdp') return printError(409, 'wrong_protocol')
		const request = parseEpsonForm(new URLSearchParams(text))
		if (!request) return printError(400, 'invalid_request')
		await recordPoll(db, device, request.report)
		if (request.kind === 'result') {
			if (request.jobId) {
				await acknowledgeJob(
					db,
					device,
					request.jobId,
					request.success
						? { ok: true }
						: { ok: false, reason: request.report.status },
				)
			}
			return new Response('', { status: 200, headers: NO_STORE })
		}
		const job = live ? await claimNextJob(db, device) : null
		if (!job) {
			return new Response('', {
				status: 200,
				headers: { ...NO_STORE, 'Content-Type': 'text/xml; charset=utf-8' },
			})
		}
		const doc = await renderJob(job, device)
		return new Response(
			epsonPrintRequest({ jobId: job.id, eposXml: renderEpsonXml(doc) }),
			{
				status: 200,
				headers: { ...NO_STORE, 'Content-Type': 'text/xml; charset=utf-8' },
			},
		)
	}

	// Star CloudPRNT: a JSON status report; the answer says whether a job waits.
	if (device.protocol !== 'star_cloudprnt') return printError(409, 'wrong_protocol')
	let body: unknown = null
	try {
		body = text ? JSON.parse(text) : null
	} catch {
		return printError(400, 'invalid_request')
	}
	await recordPoll(db, device, parseStarPoll(body))
	const job = live ? await claimNextJob(db, device) : null
	return c.json(starPollResponse(job), 200, NO_STORE)
})

async function starFetch(c: Context, jobId: string) {
	const auth = await authenticatePrinter(c, refOf(c))
	if ('error' in auth) return auth.error
	const { device, db } = auth.printer
	const job = jobId ? await jobToFetch(db, device, jobId) : null
	if (!job) return printError(404, 'job_not_found')
	const doc = await renderJob(job, device)
	return new Response(renderStarPrnt(doc) as BodyInit, {
		status: 200,
		headers: { ...NO_STORE, 'Content-Type': STAR_MEDIA_TYPE },
	})
}

async function starAck(c: Context, jobId: string) {
	const auth = await authenticatePrinter(c, refOf(c))
	if ('error' in auth) return auth.error
	const { device, db } = auth.printer
	if (!jobId) return printError(400, 'invalid_request')
	const code = c.req.query('code') ?? ''
	const ok = starAckOk(code)
	const result = await acknowledgeJob(
		db,
		device,
		jobId,
		ok
			? { ok: true }
			: {
					ok: false,
					reason: /52[01]|unsupported|media/i.test(code) ? 'unsupported' : 'error',
				},
	)
	if (result === 'unknown') return printError(404, 'job_not_found')
	return c.body(null, 200, NO_STORE)
}

printRoutes.get('/:ref/poll', (c) => starFetch(c, c.req.query('token') ?? ''))
printRoutes.delete('/:ref/poll', (c) => starAck(c, c.req.query('token') ?? ''))
printRoutes.get('/:ref/jobs/:id', (c) => starFetch(c, c.req.param('id') ?? ''))
printRoutes.delete('/:ref/jobs/:id', (c) => starAck(c, c.req.param('id') ?? ''))
