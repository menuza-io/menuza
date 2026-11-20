import { buildHostChecklist } from '@repo/common/domain-dns'
import {
	detectDomainProvider,
	getDomainProvider,
} from '@repo/common/domain-providers'
import {
	buildProviderSteps,
	renderStepsEnglish,
} from '@repo/common/domain-steps'
import {
	changeTouchesMail,
	planSiteRecords,
	type DnsChange,
} from '@repo/common/domain-zone'
import {
	describeHostname,
	hostsForConnect,
	parseHostname,
	type PrimaryForm,
} from '@repo/common/domains'
import { DomainInstructionsEmail, sendEmail } from '@repo/email'
import { createElement } from 'react'
import { getDomainAdapters } from './adapters.select.server.ts'
import { type DomainConnectSupport } from './adapters.server.ts'
import {
	fallbackNameservers,
	siteApexIps,
	siteCnameTarget,
} from './config.server.ts'
import { getDnsResolver, lookupNameservers } from './dns-resolver.server.ts'
import { rdapRegistrarLookup } from './inspect.server.ts'
import {
	addSiteDomains,
	checkAndNotify,
	ensureSiteDomains,
	primaryOf,
	type SiteDomainRow,
} from './site-domains.server.ts'

/**
 * "Connect automatically" (#313): the records are set at the operator's DNS
 * host through Domain Connect only after the operator approved the list shown
 * to them, and never email records. The plan is rebuilt on the server at
 * approval; the browser only says "approved".
 */

export type AutoConnectPlan = {
	domain: string
	hosts: string[]
	providerName: string
	changes: DnsChange[]
	/** The root could not be pointed (no ALIAS at this host and no addresses set). */
	rootSkipped: boolean
}

export class AutoConnectError extends Error {
	constructor(readonly code: 'not_supported' | 'mail_would_change') {
		super(code)
		this.name = 'AutoConnectError'
	}
}

export async function planAutoConnect(input: {
	hostname: string
	primaryForm: PrimaryForm
}): Promise<{ plan: AutoConnectPlan; support: DomainConnectSupport } | null> {
	const parsed = parseHostname(input.hostname)
	if (!parsed.ok) return null
	const parts = describeHostname(parsed.hostname)
	const hosts = hostsForConnect(parsed.hostname, input.primaryForm)
	if (!parts || !hosts) return null
	const support = await getDomainAdapters()
		.connect.discover(parts.apex)
		.catch(() => null)
	if (!support) return null

	const nameservers = await lookupNameservers(getDnsResolver(), parts.apex)
	const provider = detectDomainProvider({
		nameservers,
		registrarName: null,
		menuzaNameservers: fallbackNameservers(),
	})
	const apexMode = getDomainProvider(provider.stepsProviderId).apex
	const ips = siteApexIps()
	const all = [hosts.primary, ...hosts.redirects]
	const rootSkipped =
		apexMode === 'a_only' &&
		all.includes(parts.apex) &&
		ips.a.length + ips.aaaa.length === 0
	const changes = planSiteRecords({
		hostnames: rootSkipped ? all.filter((host) => host !== parts.apex) : all,
		cnameTarget: siteCnameTarget(),
		apexOf: (host) => describeHostname(host)?.apex ?? host,
		apexIps: ips,
		apexMode,
	})
	// The guarantee: this flow adds routing records and nothing else.
	if (changes.some((change) => changeTouchesMail(change, parts.apex))) {
		throw new AutoConnectError('mail_would_change')
	}
	return {
		plan: {
			domain: parts.apex,
			hosts: all,
			providerName: support.providerName,
			changes,
			rootSkipped,
		},
		support,
	}
}

/**
 * After approval: connect the hosts (so their certificates start) and ask the
 * DNS host to set the records. A live provider answers with its consent
 * screen; the emulator applies at once and the hosts are checked right away.
 */
export async function approveAutoConnect(input: {
	organization: { id: string; slug: string }
	hostname: string
	primaryForm: PrimaryForm
	actor: { userId: string | null; request?: Request }
	redirectUri: string
}): Promise<
	| { kind: 'redirect'; url: string; sites: SiteDomainRow[] }
	| { kind: 'applied'; sites: SiteDomainRow[]; changes: DnsChange[] }
> {
	const planned = await planAutoConnect({
		hostname: input.hostname,
		primaryForm: input.primaryForm,
	})
	if (!planned) throw new AutoConnectError('not_supported')

	const existing = await ensureSiteDomains(input.organization.id)
	const sites = await addSiteDomains({
		organization: input.organization,
		hostname: input.hostname,
		primaryForm: input.primaryForm,
		mode: primaryOf(existing) ? 'redirect' : 'primary',
		actor: input.actor,
	})
	const result = await getDomainAdapters().connect.apply({
		support: planned.support,
		domain: planned.plan.domain,
		changes: planned.plan.changes.map((change) => ({
			type: change.type,
			name: change.name,
			content: change.content,
		})),
		redirectUri: input.redirectUri,
		state: planned.plan.hosts[0] ?? planned.plan.domain,
	})
	if (result.kind === 'redirect')
		return { kind: 'redirect', url: result.url, sites }
	const checked: SiteDomainRow[] = []
	for (const site of sites) {
		checked.push((await checkAndNotify(site)).row)
	}
	return { kind: 'applied', sites: checked, changes: planned.plan.changes }
}

export class InstructionsError extends Error {
	constructor(readonly code: 'invalid_hostname' | 'invalid_email') {
		super(code)
		this.name = 'InstructionsError'
	}
}

const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/u

/**
 * "Send these steps to someone else": emails the records and the provider's
 * steps to whoever manages the domain. The address is one the operator typed
 * and the message names who asked; it changes nothing by itself.
 */
export async function sendDomainInstructions(input: {
	organizationName: string
	requestedBy: string
	hostname: string
	primaryForm: PrimaryForm
	to: string
	registrarLookup?: (apex: string) => Promise<string | null>
}) {
	const to = input.to.trim()
	if (!EMAIL_RE.test(to) || to.length > 254)
		throw new InstructionsError('invalid_email')
	const parsed = parseHostname(input.hostname)
	const parts = parsed.ok ? describeHostname(parsed.hostname) : null
	const hosts = parsed.ok
		? hostsForConnect(parsed.hostname, input.primaryForm)
		: null
	if (!parsed.ok || !parts || !hosts)
		throw new InstructionsError('invalid_hostname')

	const resolver = getDnsResolver()
	const [nameservers, registrarName] = await Promise.all([
		lookupNameservers(resolver, parts.apex),
		(input.registrarLookup ?? rdapRegistrarLookup)(parts.apex),
	])
	const detection = detectDomainProvider({
		nameservers,
		registrarName,
		menuzaNameservers: fallbackNameservers(),
	})
	const provider = getDomainProvider(detection.stepsProviderId)
	const records = [hosts.primary, ...hosts.redirects].flatMap((host) =>
		buildHostChecklist({
			hostname: host,
			role: describeHostname(host)?.role ?? 'subdomain',
			cnameTarget: siteCnameTarget(),
			apexIps: siteApexIps(),
		}),
	)
	const steps = renderStepsEnglish(
		buildProviderSteps(provider, records, parts.apex),
	)
	const lines = records.map((record) =>
		record.alternatives?.length
			? `${record.type} ${record.name} ${record.value}  (or ${record.alternatives
					.map((alt) => `${alt.type} ${alt.values.join(', ')}`)
					.join(' and ')})`
			: `${record.type} ${record.name} ${record.value}`,
	)
	const result = await sendEmail({
		to,
		subject: `Please connect ${parts.apex} to ${input.organizationName}'s website`,
		react: createElement(DomainInstructionsEmail, {
			restaurantName: input.organizationName,
			domain: parts.apex,
			requestedBy: input.requestedBy,
			steps,
			records: lines,
			providerName: provider.name || null,
		}),
	})
	return {
		sent: result.status === 'success',
		provider: detection.stepsProviderId,
	}
}
