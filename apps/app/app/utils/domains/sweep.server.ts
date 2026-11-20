import { sweepSenderDomains } from '#app/utils/email-sender/sender.server.ts'
import { type DnsResolver } from './dns-resolver.server.ts'
import { sweepForwarding } from './forwarding.server.ts'
import { processDueDomainJobs, processRenewals } from './registrar.server.ts'
import { sweepSiteDomains } from './site-domains.server.ts'
import { sweepManagedDomains } from './zone.server.ts'

/**
 * The 15-minute domain sweep (`POST /resources/jobs/domain-status`): every
 * task runs on its own, so one failing never stops the rest, and each guards
 * its own cadence (renewals charge once a day, verified sending domains are
 * looked at daily), so running often is safe.
 */
export async function runDomainSweep(
	options: { now?: Date; resolver?: DnsResolver } = {},
) {
	const result: Record<string, unknown> = {}
	const tasks: Array<[string, () => Promise<unknown>]> = [
		['siteDomains', () => sweepSiteDomains(options)],
		['nameservers', () => sweepManagedDomains(options)],
		['registrations', () => processDueDomainJobs({ now: options.now })],
		['renewals', () => processRenewals({ now: options.now })],
		['forwarding', () => sweepForwarding()],
		['senderDomains', () => sweepSenderDomains(options)],
	]
	let errors = 0
	for (const [name, run] of tasks) {
		try {
			result[name] = await run()
		} catch (error) {
			errors += 1
			result[name] = { error: true }
			console.error(
				`Domain sweep task ${name} failed:`,
				error instanceof Error ? error.message : error,
			)
		}
	}
	return { ...result, errors }
}
