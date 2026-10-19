import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from '@repo/ui/collapsible'
import { Icon } from '@repo/ui/icon'
import { Sheet, SheetContent } from '@repo/ui/sheet'
import { type FormEvent, useMemo, useState } from 'react'
import { useRevealedErrors } from '#app/components/reservations/settings/use-revealed-errors.ts'
import {
	type Option,
	SelectField,
	TextField,
} from '#app/components/staff/controls.tsx'
import { SheetForm } from '#app/components/staff/sheet-frame.tsx'
import { SwitchField } from '#app/components/staff/switch-field.tsx'
import {
	createExperience,
	EXPERIENCE_KINDS,
	EXPERIENCE_LOCALES,
	type ExperienceDto,
	type ExperienceKind,
	type ExperienceLocale,
} from '#app/utils/reservations/experiences-api.ts'
import {
	emptyExperienceForm,
	EXPERIENCE_KIND_LABELS,
	EXPERIENCE_LOCALE_LABELS,
	experienceErrorMessages,
	experienceFormToInput,
	type ExperienceFormErrors,
	slugify,
} from '#app/utils/reservations/experiences-view.ts'
import { type ReservationsScopedClient } from '#app/utils/reservations/reservations-client.ts'

/**
 * The few fields needed to start an experience as a draft. Schedules, longer
 * descriptions and the policy are set in the editor it opens next.
 */
export function ExperienceCreateSheet({
	open,
	onClose,
	client,
	locationId,
	currency,
	onCreated,
}: {
	open: boolean
	onClose: () => void
	client: ReservationsScopedClient
	locationId: string
	currency: string
	onCreated: (experience: ExperienceDto) => void
}) {
	return (
		<Sheet open={open} onOpenChange={(next) => !next && onClose()}>
			<SheetContent
				className="sm:max-w-md"
				data-testid="experience-create-sheet"
			>
				{open ? (
					<Body
						onClose={onClose}
						client={client}
						locationId={locationId}
						currency={currency}
						onCreated={onCreated}
					/>
				) : null}
			</SheetContent>
		</Sheet>
	)
}

function Body({
	onClose,
	client,
	locationId,
	currency,
	onCreated,
}: Omit<Parameters<typeof ExperienceCreateSheet>[0], 'open'>) {
	const { t, i18n } = useLingui()
	const initialLocale = (i18n.locale === 'ar' ? 'ar' : 'en') as ExperienceLocale
	const [form, setForm] = useState(emptyExperienceForm)
	const [nameLocale, setNameLocale] = useState<ExperienceLocale>(initialLocale)
	const [slugTouched, setSlugTouched] = useState(false)
	// Derived from the form on every render and revealed after a submit attempt,
	// so a message goes away as soon as the value is valid.
	const parsed = useMemo(
		() => experienceFormToInput(form, currency),
		[form, currency],
	)
	const { errors, attempt } = useRevealedErrors<
		keyof ExperienceFormErrors,
		MessageDescriptor
	>(parsed.ok ? {} : parsed.errors)
	const [banner, setBanner] = useState<string[]>([])
	const [pending, setPending] = useState(false)
	const [moreOpen, setMoreOpen] = useState(false)

	const kindOptions: Option[] = useMemo(
		() =>
			EXPERIENCE_KINDS.map((value) => ({
				value,
				label: i18n._(EXPERIENCE_KIND_LABELS[value]),
			})),
		[i18n],
	)
	const localeOptions: Option[] = useMemo(
		() =>
			EXPERIENCE_LOCALES.map((value) => ({
				value,
				label: i18n._(EXPERIENCE_LOCALE_LABELS[value]),
			})),
		[i18n],
	)
	const message = (field: keyof ExperienceFormErrors) =>
		errors[field] ? i18n._(errors[field]!) : null

	function setName(value: string) {
		setForm((current) => ({
			...current,
			names: { ...current.names, [nameLocale]: value },
			slug: slugTouched ? current.slug : slugify(value),
		}))
	}

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		attempt()
		setBanner([])
		if (!parsed.ok) {
			// Only a real link-name problem opens the advanced section.
			if (parsed.errors.slug) setMoreOpen(true)
			return
		}
		setPending(true)
		try {
			onCreated(await createExperience(client, locationId, parsed.input))
		} catch (error) {
			setBanner(
				experienceErrorMessages(
					error,
					(descriptor) => i18n._(descriptor),
					msg`The experience could not be created. Try again.`,
				),
			)
		} finally {
			setPending(false)
		}
	}

	return (
		<SheetForm
			title={t`New experience`}
			description={t`Start a draft. You add schedules and publish it on the next screen.`}
			onSubmit={submit}
			footer={
				<>
					<Button type="button" variant="ghost" onClick={onClose}>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						type="submit"
						disabled={pending}
						data-testid="experience-create"
					>
						{pending ? <Trans>Creating…</Trans> : <Trans>Create draft</Trans>}
					</Button>
				</>
			}
		>
			{banner.length > 0 ? (
				<Alert variant="destructive" data-testid="experience-create-error">
					<AlertDescription>{banner.join(' ')}</AlertDescription>
				</Alert>
			) : null}
			<TextField
				label={<Trans>Name</Trans>}
				value={form.names[nameLocale] ?? ''}
				onChange={(event) => setName(event.target.value)}
				maxLength={140}
				error={message('name')}
				dir={nameLocale === 'ar' ? 'rtl' : 'ltr'}
				data-testid="experience-name"
			/>
			<SelectField
				label={<Trans>Type</Trans>}
				value={form.kind}
				options={kindOptions}
				onValueChange={(value) =>
					setForm((current) => ({ ...current, kind: value as ExperienceKind }))
				}
				id="experience-kind"
			/>
			<TextField
				label={<Trans>Price ({currency})</Trans>}
				optional
				inputMode="decimal"
				value={form.price}
				onChange={(event) =>
					setForm((current) => ({ ...current, price: event.target.value }))
				}
				error={message('price')}
				data-testid="experience-price"
			/>
			<div className="grid grid-cols-2 gap-4">
				<TextField
					label={<Trans>Smallest party</Trans>}
					inputMode="numeric"
					value={form.partyMin}
					onChange={(event) =>
						setForm((current) => ({ ...current, partyMin: event.target.value }))
					}
					error={message('partyMin')}
					data-testid="experience-party-min"
				/>
				<TextField
					label={<Trans>Largest party</Trans>}
					inputMode="numeric"
					value={form.partyMax}
					onChange={(event) =>
						setForm((current) => ({ ...current, partyMax: event.target.value }))
					}
					error={message('partyMax')}
					data-testid="experience-party-max"
				/>
			</div>
			<Collapsible open={moreOpen} onOpenChange={setMoreOpen}>
				<CollapsibleTrigger
					render={<Button type="button" variant="ghost" size="sm" />}
					className="-ms-2 self-start"
					data-testid="experience-more-toggle"
				>
					<Icon name="chevron-down" className="size-4" />
					<Trans>More options</Trans>
				</CollapsibleTrigger>
				<CollapsibleContent>
					<div className="flex flex-col gap-4 pt-2">
						<SelectField
							label={<Trans>Name language</Trans>}
							hint={<Trans>You can add more languages later.</Trans>}
							value={nameLocale}
							options={localeOptions}
							onValueChange={(value) =>
								setNameLocale(value as ExperienceLocale)
							}
							id="experience-name-locale"
						/>
						<TextField
							label={<Trans>Link name</Trans>}
							hint={
								<Trans>
									Used in the web address of the page. Lowercase letters,
									numbers and dashes.
								</Trans>
							}
							value={form.slug}
							onChange={(event) => {
								setSlugTouched(true)
								setForm((current) => ({ ...current, slug: event.target.value }))
							}}
							maxLength={64}
							error={message('slug')}
							dir="ltr"
							data-testid="experience-slug"
						/>
						<SwitchField
							label={<Trans>Price is per guest</Trans>}
							description={<Trans>Off: one price for the whole booking.</Trans>}
							checked={form.pricePerCover}
							onCheckedChange={(value) =>
								setForm((current) => ({ ...current, pricePerCover: value }))
							}
						/>
					</div>
				</CollapsibleContent>
			</Collapsible>
		</SheetForm>
	)
}
