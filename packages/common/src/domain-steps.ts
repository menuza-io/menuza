import { type ChecklistRecord } from './domain-dns.ts'
import { type DomainProvider } from './domain-providers.ts'

/**
 * The steps that connect a domain at a given provider (#313), as data: what to
 * open, which button, which field gets which value. The App turns the kinds
 * into translated sentences; `renderStepsEnglish` writes the same steps for the
 * email to a person who manages the domain.
 */

export type RecordEntry = {
	/** What to choose in the type field. */
	type: string
	/** What to type in the host field (`www`, `@`, or the full name). */
	host: string
	/** What to type in the value field. */
	value: string
	/** More than one value (the A records of the root). */
	values?: string[]
}

export type StepLine =
	| { kind: 'sign_in'; provider: string }
	| { kind: 'open_dns'; path: string; domain: string }
	| { kind: 'add_record'; label: string }
	| {
			kind: 'fill'
			entry: RecordEntry
			fields: DomainProvider['fields']
	  }
	| { kind: 'root_a_fallback'; entry: RecordEntry }
	| { kind: 'proxy_off' }
	| { kind: 'default_records' }
	| { kind: 'keep_mail' }
	| { kind: 'wait'; minutes: number }

function hostField(
	provider: DomainProvider,
	name: string,
	domain: string,
): string {
	if (name === domain) return provider.rootHost
	return provider.hostStyle === 'full'
		? name
		: name.slice(0, -(domain.length + 1))
}

/** The record entries for the provider: ALIAS where it works, A records where not. */
export function entriesFor(
	provider: DomainProvider,
	records: ChecklistRecord[],
	domain: string,
): { entries: RecordEntry[]; fallbacks: RecordEntry[] } {
	const entries: RecordEntry[] = []
	const fallbacks: RecordEntry[] = []
	for (const record of records.filter((r) => r.kind === 'route')) {
		const host = hostField(provider, record.name, domain)
		if (record.type !== 'ALIAS') {
			entries.push({ type: record.type, host, value: record.value })
			continue
		}
		const a = record.alternatives?.find((alt) => alt.type === 'A')
		const aaaa = record.alternatives?.find((alt) => alt.type === 'AAAA')
		const aEntry: RecordEntry | null = a
			? { type: 'A', host, value: a.values[0]!, values: a.values }
			: null
		if (provider.apex === 'alias' || !aEntry) {
			entries.push({ type: 'ALIAS', host, value: record.value })
			if (aEntry) fallbacks.push(aEntry)
		} else {
			entries.push(aEntry)
			if (aaaa) {
				entries.push({
					type: 'AAAA',
					host,
					value: aaaa.values[0]!,
					values: aaaa.values,
				})
			}
		}
	}
	return { entries, fallbacks }
}

export function buildProviderSteps(
	provider: DomainProvider,
	records: ChecklistRecord[],
	domain: string,
): StepLine[] {
	const steps: StepLine[] = []
	if (provider.name) steps.push({ kind: 'sign_in', provider: provider.name })
	if (provider.dnsPath) {
		steps.push({ kind: 'open_dns', path: provider.dnsPath, domain })
	}
	const { entries, fallbacks } = entriesFor(provider, records, domain)
	for (const entry of entries) {
		if (provider.addLabel)
			steps.push({ kind: 'add_record', label: provider.addLabel })
		steps.push({ kind: 'fill', entry, fields: provider.fields })
	}
	for (const entry of fallbacks) steps.push({ kind: 'root_a_fallback', entry })
	if (provider.quirk === 'proxy_off') steps.push({ kind: 'proxy_off' })
	if (provider.quirk === 'default_records')
		steps.push({ kind: 'default_records' })
	steps.push({ kind: 'keep_mail' })
	steps.push({ kind: 'wait', minutes: 30 })
	return steps
}

function entryText(entry: RecordEntry, fields: DomainProvider['fields']) {
	const values = entry.values?.length ? entry.values.join(', ') : entry.value
	return `${fields.type}: ${entry.type}, ${fields.host}: ${entry.host || '(leave empty)'}, ${fields.value}: ${values}`
}

/** The same steps as plain English, for the email to whoever manages the domain. */
export function renderStepsEnglish(steps: StepLine[]): string[] {
	return steps.map((step) => {
		switch (step.kind) {
			case 'sign_in':
				return `Sign in to ${step.provider}, where the domain's DNS is managed.`
			case 'open_dns':
				return `Open the DNS records for ${step.domain}: ${step.path}.`
			case 'add_record':
				return `Choose "${step.label}".`
			case 'fill':
				return `Enter this record. ${entryText(step.entry, step.fields)}`
			case 'root_a_fallback':
				return `If your provider does not accept ALIAS, ANAME or CNAME at the root, add A records pointing to ${step.entry.values?.join(', ') ?? step.entry.value} instead.`
			case 'proxy_off':
				return 'Set the proxy status to "DNS only" (grey cloud) so the certificate can be issued.'
			case 'default_records':
				return 'Remove any default record that points the same name at a parking page, so only one record is left for it.'
			case 'keep_mail':
				return 'Do not change or delete any MX or TXT records: they carry the email for this domain.'
			case 'wait':
				return `Save. It can take up to ${step.minutes} minutes (sometimes longer) to take effect.`
		}
	})
}
