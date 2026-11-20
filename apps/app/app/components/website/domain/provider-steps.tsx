import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import { type StepLine } from '@repo/common/domain-steps'
import { CopyValue } from './domain-ui.tsx'

/**
 * The steps for a domain provider (#313), in the operator's language. The
 * provider's own button and field names stay as they appear on its page.
 */

export function stepText(
	step: StepLine,
	_: (descriptor: MessageDescriptor) => string,
): string {
	switch (step.kind) {
		case 'sign_in': {
			const provider = step.provider
			return _(msg`Sign in to ${provider}, where your domain's DNS is managed.`)
		}
		case 'open_dns': {
			const { path, domain } = step
			return _(msg`Open the DNS records for ${domain}: ${path}.`)
		}
		case 'add_record': {
			const label = step.label
			return _(msg`Choose "${label}".`)
		}
		case 'fill':
			return _(msg`Enter the record below.`)
		case 'root_a_fallback': {
			const values = step.entry.values?.join(', ') ?? step.entry.value
			return _(
				msg`If your provider does not accept ALIAS, ANAME or CNAME at the root, add A records pointing to ${values} instead.`,
			)
		}
		case 'proxy_off':
			return _(
				msg`Set the proxy status to "DNS only" (grey cloud) so the certificate can be issued.`,
			)
		case 'default_records':
			return _(
				msg`Remove any default record that points the same name at a parking page, so only one record is left for it.`,
			)
		case 'keep_mail':
			return _(
				msg`Do not change or delete any MX or TXT records: they carry the email for this domain.`,
			)
		case 'wait': {
			const minutes = step.minutes
			return _(
				msg`Save. It can take up to ${minutes} minutes (sometimes longer) to take effect.`,
			)
		}
	}
}

export function ProviderSteps({
	steps,
	_,
}: {
	steps: StepLine[]
	_: (descriptor: MessageDescriptor) => string
}) {
	return (
		<ol className="space-y-3 text-sm">
			{steps.map((step, index) => (
				<li key={`${step.kind}-${index}`} className="flex gap-3">
					<span className="bg-muted text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-full text-xs">
						{index + 1}
					</span>
					<div className="min-w-0 space-y-2">
						<p>{stepText(step, _)}</p>
						{step.kind === 'fill' ? (
							<dl className="grid gap-1 text-xs sm:grid-cols-[auto_1fr] sm:gap-x-3">
								<dt className="text-muted-foreground">{step.fields.type}</dt>
								<dd className="font-mono">{step.entry.type}</dd>
								<dt className="text-muted-foreground">{step.fields.host}</dt>
								<dd>
									{step.entry.host ? (
										<CopyValue value={step.entry.host} />
									) : (
										<span className="text-muted-foreground">
											{_(msg`(leave empty)`)}
										</span>
									)}
								</dd>
								<dt className="text-muted-foreground">{step.fields.value}</dt>
								<dd className="space-y-1">
									{(step.entry.values?.length
										? step.entry.values
										: [step.entry.value]
									).map((value) => (
										<CopyValue key={value} value={value} />
									))}
								</dd>
							</dl>
						) : null}
					</div>
				</li>
			))}
		</ol>
	)
}
