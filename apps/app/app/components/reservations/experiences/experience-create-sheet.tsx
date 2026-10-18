import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Sheet, SheetContent } from '@repo/ui/sheet'
import { type FormEvent, useMemo, useState } from 'react'
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
	const [errors, setErrors] = useState<ExperienceFormErrors>({})
	const [banner, setBanner] = useState<string[]>([])
	const [pending, setPending] = useState(false)

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
		const parsed = experienceFormToInput(form, currency)
		if (!parsed.ok) {
			setErrors(parsed.errors)
			setBanner([])
			return
		}
		setErrors({})
		setBanner([])
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
			<SelectField
				label={<Trans>Name language</Trans>}
				hint={<Trans>You can add more languages later.</Trans>}
				value={nameLocale}
				options={localeOptions}
				onValueChange={(value) => setNameLocale(value as ExperienceLocale)}
				id="experience-name-locale"
			/>
			<TextField
				label={<Trans>Name</Trans>}
				value={form.names[nameLocale] ?? ''}
				onChange={(event) => setName(event.target.value)}
				maxLength={140}
				error={message('name')}
				dir={nameLocale === 'ar' ? 'rtl' : 'ltr'}
				data-testid="experience-name"
			/>
			<TextField
				label={<Trans>Link name</Trans>}
				hint={
					<Trans>
						Used in the web address of the page. Lowercase letters, numbers and
						dashes.
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
			<SwitchField
				label={<Trans>Price is per guest</Trans>}
				description={<Trans>Off: one price for the whole booking.</Trans>}
				checked={form.pricePerCover}
				onCheckedChange={(value) =>
					setForm((current) => ({ ...current, pricePerCover: value }))
				}
			/>
		</SheetForm>
	)
}
