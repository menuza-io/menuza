import {
	analyzeMail,
	analyzeWebsite,
	COMMON_DKIM_SELECTORS,
	findAcmeLeftovers,
	type MailFindings,
	type WebsiteFindings,
} from '@repo/common/domain-dns'
import {
	detectDomainProvider,
	type ProviderDetection,
} from '@repo/common/domain-providers'
import {
	describeHostname,
	parseHostname,
	siblingHostname,
	trimDnsName,
	type HostRole,
} from '@repo/common/domains'
import { findHostOwner } from '#app/utils/sites/site-host.server.ts'
import { getDomainAdapters } from './adapters.select.server.ts'
import { fallbackNameservers, siteCnameTarget } from './config.server.ts'
import {
	getDnsResolver,
	lookupMany,
	lookupMx,
	lookupNameservers,
	lookupTxt,
	type DnsResolver,
} from './dns-resolver.server.ts'
import { ensureSiteDomains, primaryOf } from './site-domains.server.ts'

/**
 * Looks a domain up before anything is changed (#139, #313): who hosts its
 * DNS and where it is registered, whether it receives email, whether a website
 * already answers on it, whether another site has it, and whether a previous
 * certificate provider left a challenge record. Read-only: public DNS and
 * public registration data, for a name the operator typed.
 */

export type DomainWarningCode =
	| 'mail'
	| 'mail_records_only'
	| 'website'
	| 'subdomain'
	| 'taken'
	| 'acme_leftover'
	| 'other_live_domain'

export type DomainInspection = {
	hostname: string
	apex: string
	role: HostRole
	detection: ProviderDetection
	mail: MailFindings
	website: WebsiteFindings
	acmeLeftovers: string[]
	/** Another organization already has this host (or its other form). */
	takenByOther: boolean
	/** This organization already has it. */
	alreadyConnected: boolean
	/** A subdomain was typed where the root was probably meant. */
	subdomainSuggestion: string | null
	/** The restaurant's own live primary domain when this one is a different domain. */
	otherLiveDomain: string | null
	warnings: DomainWarningCode[]
	/** `simple`: let Menuza manage the domain; `manual`: add the records yourself. */
	setup: 'simple' | 'manual'
	/** The DNS host supports Domain Connect. */
	autoConnect: { providerName: string } | null
	canManageNameservers: boolean
}

export type RegistrarLookup = (apexDomain: string) => Promise<string | null>

/** The registrar named by public RDAP data (rdap.org redirects to the registry). */
export const rdapRegistrarLookup: RegistrarLookup = async (apex) => {
	try {
		const response = await fetch(
			`https://rdap.org/domain/${encodeURIComponent(apex)}`,
			{
				headers: { Accept: 'application/rdap+json, application/json' },
				signal: AbortSignal.timeout(5_000),
			},
		)
		if (!response.ok) return null
		const body = (await response.json()) as {
			entities?: Array<{
				roles?: string[]
				vcardArray?: [string, Array<[string, unknown, unknown, string]>]
			}>
		}
		const registrar = body.entities?.find((entity) =>
			entity.roles?.includes('registrar'),
		)
		const name = registrar?.vcardArray?.[1]?.find(
			(field) => field[0] === 'fn',
		)?.[3]
		return typeof name === 'string' && name.trim() ? name.trim() : null
	} catch {
		return null
	}
}

export async function inspectDomain(input: {
	organizationId: string
	hostname: string
	resolver?: DnsResolver
	registrarLookup?: RegistrarLookup
}): Promise<DomainInspection | null> {
	const parsed = parseHostname(input.hostname)
	if (!parsed.ok) return null
	const parts = describeHostname(parsed.hostname)
	if (!parts) return null
	const resolver = input.resolver ?? getDnsResolver()
	const registrarLookup = input.registrarLookup ?? rdapRegistrarLookup
	const apex = parts.apex
	const www = `www.${apex}`
	const target = siteCnameTarget()

	const [
		nameservers,
		registrarName,
		mx,
		apexTxt,
		dmarcTxt,
		dkimValues,
		apexAnswers,
		wwwAnswers,
		challengeTxt,
		challengeCname,
		support,
	] = await Promise.all([
		lookupNameservers(resolver, apex),
		registrarLookup(apex),
		lookupMx(resolver, apex),
		lookupTxt(resolver, apex),
		lookupTxt(resolver, `_dmarc.${apex}`),
		Promise.all(
			COMMON_DKIM_SELECTORS.map(async (selector) => {
				const name = `${selector}._domainkey.${apex}`
				const [txt, cname] = await Promise.all([
					lookupTxt(resolver, name),
					resolver(name, 'CNAME'),
				])
				return {
					selector: selector as string,
					values: [...txt, ...cname.map((answer) => trimDnsName(answer.data))],
				}
			}),
		),
		lookupMany(resolver, apex, ['A', 'AAAA', 'CNAME']),
		lookupMany(resolver, www, ['A', 'CNAME']),
		lookupTxt(resolver, `_acme-challenge.${parsed.hostname}`),
		resolver(`_acme-challenge.${parsed.hostname}`, 'CNAME'),
		getDomainAdapters()
			.connect.discover(apex)
			.catch(() => null),
	])

	const detection = detectDomainProvider({
		nameservers,
		registrarName,
		menuzaNameservers: fallbackNameservers(),
	})
	const mail = analyzeMail({ mx, apexTxt, dmarcTxt, dkim: dkimValues }, apex)
	const data = (answers: Array<{ data: string }>) => answers.map((a) => a.data)
	const website = analyzeWebsite({
		apexA: data(apexAnswers.A),
		apexAaaa: data(apexAnswers.AAAA),
		apexCname: data(apexAnswers.CNAME),
		wwwA: data(wwwAnswers.A),
		wwwCname: data(wwwAnswers.CNAME),
		cnameTarget: target,
	})
	const acmeLeftovers = findAcmeLeftovers({
		hostname: parsed.hostname,
		challengeTxt,
		challengeCname: challengeCname.map((answer) => answer.data),
	})

	const sibling = siblingHostname(parsed.hostname)
	const [owner, siblingOwner] = await Promise.all([
		findHostOwner(parsed.hostname),
		sibling ? findHostOwner(sibling) : Promise.resolve(null),
	])
	const takenByOther = [owner, siblingOwner].some(
		(entry) => entry && entry.organizationId !== input.organizationId,
	)
	const alreadyConnected = [owner].some(
		(entry) => entry && entry.organizationId === input.organizationId,
	)

	const siteDomains = await ensureSiteDomains(input.organizationId)
	const primary = primaryOf(siteDomains)
	const primaryApex = primary ? describeHostname(primary.hostname)?.apex : null
	const otherLiveDomain =
		primary &&
		primary.status === 'active' &&
		primaryApex &&
		primaryApex !== apex
			? primary.hostname
			: null

	const subdomainSuggestion = parts.role === 'subdomain' ? apex : null

	const warnings: DomainWarningCode[] = []
	if (mail.kind === 'mail') warnings.push('mail')
	if (mail.kind === 'records_only') warnings.push('mail_records_only')
	if (website.hasWebsite) warnings.push('website')
	if (subdomainSuggestion) warnings.push('subdomain')
	if (acmeLeftovers.length > 0) warnings.push('acme_leftover')
	if (otherLiveDomain) warnings.push('other_live_domain')

	return {
		hostname: parsed.hostname,
		apex,
		role: parts.role,
		detection,
		mail,
		website,
		acmeLeftovers,
		takenByOther,
		alreadyConnected,
		subdomainSuggestion,
		otherLiveDomain,
		warnings,
		setup:
			mail.kind !== 'none' || website.hasWebsite || parts.role === 'subdomain'
				? 'manual'
				: 'simple',
		autoConnect: support ? { providerName: support.providerName } : null,
		canManageNameservers:
			parts.role !== 'subdomain' && !detection.managedByMenuza,
	}
}
