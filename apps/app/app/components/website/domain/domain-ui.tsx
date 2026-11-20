import { type MessageDescriptor } from '@lingui/core'
import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	ChoiceCard,
	ChoiceCardContent,
	ChoiceCardDescription,
	ChoiceCardTitle,
} from '@repo/ui/choice-card'
import { Icon } from '@repo/ui/icon'
import { RadioGroupItem } from '@repo/ui/radio-group'
import { useEffect, useRef } from 'react'
import { useFetcher } from 'react-router'
import { toast } from 'sonner'

/**
 * Shared pieces of the Website, Domain screen: the fetcher every card posts
 * with, the words for every error code the server can answer, copy buttons and
 * status badges. Server answers are `{ ok, intent, error? }` JSON.
 */

export type ActionResult = {
	ok: boolean
	intent: string
	error?: string
	[key: string]: unknown
}

const ERRORS: Record<string, MessageDescriptor> = {
	invalid_request: msg`Something in the form is not valid. Check it and try again.`,
	rate_limited: msg`Too many lookups for now. Try again in a little while.`,
	unexpected: msg`Something went wrong. Please try again.`,
	hostname_invalid: msg`Enter a domain like example.com.`,
	hostname_reserved: msg`That address belongs to our own platform and cannot be connected.`,
	hostname_taken: msg`That domain is already connected to another restaurant.`,
	domain_limit: msg`You have reached the limit of domains for this site.`,
	primary_exists: msg`Your site already has a primary domain. Add this one as an extra domain instead.`,
	no_primary: msg`Connect your main domain first.`,
	already_connected: msg`That domain is already connected here.`,
	primary_in_use: msg`This is your primary domain. Make another one primary first, or disconnect everything.`,
	not_found: msg`We could not find that.`,
	cloudflare_failed: msg`We could not set the domain up. Please try again in a moment.`,
	subdomain_not_allowed: msg`Letting Menuza manage a domain needs the main domain (example.com), not a subdomain.`,
	email_confirmation_required: msg`Type the domain to confirm that email may stop working.`,
	zone_exists: msg`Menuza already manages this domain.`,
	zone_failed: msg`We could not create the DNS zone. Please try again.`,
	invalid_record: msg`That record is not valid. Check the highlighted problems.`,
	managed_readonly: msg`This record is managed by Menuza for your site and cannot be changed.`,
	forwarding_active: msg`Turn off email forwarding before you stop managing this domain.`,
	registered_here: msg`A domain bought here stays with Menuza. Transfer it out instead.`,
	not_supported: msg`Your domain provider does not support automatic setup. Use the steps instead.`,
	mail_would_change: msg`That would change email records, so we stopped.`,
	invalid_email: msg`Enter one email address.`,
	invalid_hostname: msg`Enter a domain like example.com.`,
	email_failed: msg`We could not send the email. Try again.`,
	feature_off: msg`This is not available for your account yet.`,
	not_configured: msg`Buying domains is not set up yet.`,
	domain_unavailable: msg`That domain was just taken. You were not charged.`,
	tld_not_supported: msg`We only sell .com domains for now.`,
	price_changed: msg`The price changed. Review it and try again.`,
	no_card_on_file: msg`Add a card in Billing first, then come back.`,
	card_declined: msg`Your card was declined. You were not charged.`,
	payment_failed: msg`The payment did not go through. You were not charged.`,
	invalid_contact: msg`Check the owner details: every field except address line 2 is required.`,
	too_new: msg`A domain cannot be transferred within 60 days of registering or a previous transfer.`,
	locked: msg`The domain is locked at its current registrar. Unlock it there and try again.`,
	invalid_auth_code: msg`That authorization code is not right.`,
	transfer_failed: msg`The transfer could not start. You were not charged.`,
	not_active: msg`This domain is not active.`,
	not_confirmed_yet: msg`The registry has not seen your confirmation yet. Click the link in its email first.`,
	not_managed: msg`Menuza does not manage this domain's DNS.`,
	nameservers_pending: msg`Move this domain to Menuza's nameservers first.`,
	mx_confirmation_required: msg`This domain already receives email. Type the domain to confirm that forwarding replaces it.`,
	limit_reached: msg`You can forward at most 10 addresses per domain.`,
	invalid_address: msg`Use letters, numbers, dots, dashes or a *, with no spaces.`,
	invalid_destination: msg`Enter one email address to forward to.`,
	destination_on_domain: msg`Forward to an inbox outside this domain.`,
	duplicate: msg`That address is already set up.`,
	provider_failed: msg`The mail service did not answer. Try again.`,
	invalid_sender_name: msg`The sender name can be up to 64 characters and cannot contain @, <, >, quotes, commas or line breaks.`,
	invalid_reply_to: msg`Enter one email address.`,
	reply_to_unverified: msg`Confirm the reply-to address with the code first.`,
	code_invalid: msg`That code is not right.`,
	code_expired: msg`That code expired. Send a new one.`,
	too_many_attempts: msg`Too many wrong codes. Send a new one.`,
	resend_too_soon: msg`A code was just sent. Wait a minute before asking for another.`,
	no_pending_reply_to: msg`Ask for a code first.`,
	domain_in_use: msg`Another restaurant already uses that sending domain.`,
	invalid_domain: msg`Enter a domain like acmepizza.com.`,
	invalid_local_part: msg`Use letters, numbers, dots, dashes or underscores before the @.`,
	no_domain: msg`Add a sending domain first.`,
}

export function errorMessage(
	code: string | undefined,
	_: (descriptor: MessageDescriptor) => string,
): string {
	return _(ERRORS[code ?? ''] ?? ERRORS.unexpected!)
}

const ISSUES: Record<string, MessageDescriptor> = {
	invalid_name: msg`The name is not valid.`,
	name_outside_zone: msg`The name must be inside this domain.`,
	invalid_content: msg`The value does not fit this record type.`,
	invalid_ttl: msg`TTL must be Auto or 60 to 86400 seconds.`,
	mx_priority_required: msg`An MX record needs a priority from 0 to 65535.`,
	duplicate: msg`This record already exists.`,
	spf_duplicate: msg`A name can have only one SPF record. Edit the existing one.`,
	cname_conflict: msg`A CNAME cannot share its name with other records.`,
	managed_readonly: msg`This record is managed by Menuza and cannot be changed.`,
	apex_ns: msg`NS records at the root cannot be changed.`,
	too_many_records: msg`This domain has reached the limit of records.`,
	txt_too_long: msg`A TXT value can be at most 2048 characters.`,
	invalid_type: msg`That record type is not supported.`,
}

export function issueMessage(
	code: string,
	_: (descriptor: MessageDescriptor) => string,
): string {
	return _(ISSUES[code] ?? ERRORS.invalid_record!)
}

/** A form-posting fetcher that reports the server's error and refreshes the page. */
export function useDomainFetcher(
	options: {
		/** Shown when the action succeeds. */
		success?: MessageDescriptor
		onSuccess?: (result: ActionResult) => void
		silent?: boolean
	} = {},
) {
	const fetcher = useFetcher<ActionResult>()
	const { _ } = useLingui()
	const seen = useRef<unknown>(null)
	const { onSuccess, success, silent } = options
	const data = fetcher.data
	useEffect(() => {
		if (!data || seen.current === data) return
		seen.current = data
		if (data.ok) {
			if (success) toast.success(_(success))
			onSuccess?.(data)
		} else if (!silent) {
			toast.error(errorMessage(data.error, _))
		}
	}, [data, _, success, onSuccess, silent])
	return {
		fetcher,
		Form: fetcher.Form,
		busy: fetcher.state !== 'idle',
		result: data,
		error: data && !data.ok ? data.error : undefined,
		submit(values: Record<string, string>) {
			void fetcher.submit(values, { method: 'POST' })
		},
	}
}

export function CopyButton({
	value,
	label,
}: {
	value: string
	label?: string
}) {
	const { _ } = useLingui()
	return (
		<Button
			type="button"
			variant="ghost"
			size="icon-sm"
			aria-label={label ?? _(msg`Copy`)}
			onClick={() => {
				void navigator.clipboard
					?.writeText(value)
					.then(() => toast.success(_(msg`Copied`)))
					.catch(() => toast.error(_(msg`Could not copy`)))
			}}
		>
			<Icon name="copy" className="size-3.5" />
		</Button>
	)
}

/** One value with its copy button, selectable. */
export function CopyValue({ value }: { value: string }) {
	return (
		<span className="flex min-w-0 items-center gap-1">
			<code className="bg-muted min-w-0 rounded-md px-2 py-1 font-mono text-xs break-all">
				{value}
			</code>
			<CopyButton value={value} />
		</span>
	)
}

export function RecordStatus({
	check,
}: {
	check: 'found' | 'missing' | 'mismatch' | 'unknown' | undefined
}) {
	if (check === 'found') {
		return (
			<Badge variant="success">
				<Icon name="check" />
				<Trans>Found</Trans>
			</Badge>
		)
	}
	if (check === 'mismatch') {
		return (
			<Badge variant="warning">
				<Trans>Points elsewhere</Trans>
			</Badge>
		)
	}
	if (check === 'missing') {
		return (
			<Badge variant="secondary">
				<Trans>Not found yet</Trans>
			</Badge>
		)
	}
	return (
		<Badge variant="outline">
			<Trans>Not checked</Trans>
		</Badge>
	)
}

export function SectionNote({ children }: { children: React.ReactNode }) {
	return <p className="text-muted-foreground text-sm">{children}</p>
}

/** A card in a RadioGroup: the radio, a title and a line of explanation. */
export function Choice({
	value,
	title,
	description,
}: {
	value: string
	title: string
	description?: string
}) {
	return (
		<ChoiceCard>
			<RadioGroupItem value={value} />
			<ChoiceCardContent>
				<ChoiceCardTitle>{title}</ChoiceCardTitle>
				{description ? (
					<ChoiceCardDescription>{description}</ChoiceCardDescription>
				) : null}
			</ChoiceCardContent>
		</ChoiceCard>
	)
}
