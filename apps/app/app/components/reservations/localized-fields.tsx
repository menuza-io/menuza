import { Trans } from '@lingui/react/macro'
import {
	getLocalizedEditableValue,
	getSiteLocaleDirection,
	getSiteLocaleLabel,
	type SiteLocalesConfig,
} from '@repo/common/site-locales'
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/field'
import {
	type ComponentProps,
	type ReactNode,
	useCallback,
	useContext,
	useId,
	useMemo,
	useState,
} from 'react'
import {
	LocaleContext,
	LocaleSwitcher,
	LocalizedInput,
	LocalizedTextarea,
} from '#app/components/website/locale-fields.tsx'
import { TranslateProvider } from '#app/components/website/translate-provider.tsx'
import { type LocalizedMap } from '#app/utils/reservations/localized.ts'
import { useReservationLocales } from '#app/utils/reservations/use-reservation-locales.ts'

/**
 * Guest-facing Reservations text is edited the way Menu and Drops text is: one
 * field that shows the active language, a switcher in the header, and the
 * organization's default language as the required one. The languages come from
 * Website settings (`useReservationLocales`), never from this module, and the
 * operator's interface language never picks the language being written.
 */

export function ReservationLocaleProvider({
	children,
	config,
}: {
	children: ReactNode
	/** Overrides the languages from the layout loader (tests, previews). */
	config?: SiteLocalesConfig
}) {
	const fromLoader = useReservationLocales()
	const { locales, defaultLocale } = config ?? fromLoader
	const [chosen, setChosen] = useState<string>(defaultLocale)
	// A language removed from Website settings while a sheet is open falls back to the default.
	const activeLocale = locales.includes(chosen) ? chosen : defaultLocale
	const value = useMemo(
		() => ({
			activeLocale,
			defaultLocale,
			locales: [...locales],
			setActiveLocale: setChosen,
		}),
		[activeLocale, defaultLocale, locales],
	)
	return (
		<LocaleContext.Provider value={value}>
			{/* Translating needs a second language; a one-language organization never shows it. */}
			{locales.length > 1 ? (
				<TranslateProvider
					activeLocale={activeLocale}
					defaultLocale={defaultLocale}
				>
					{children}
				</TranslateProvider>
			) : (
				children
			)}
		</LocaleContext.Provider>
	)
}

/** The language switcher; renders nothing for a one-language organization. */
export const ReservationLocaleSwitcher = LocaleSwitcher

export function useActiveLocale() {
	return useContext(LocaleContext)
}

function useMapAdapter(
	value: LocalizedMap | null | undefined,
	onChange: (next: LocalizedMap) => void,
) {
	const { activeLocale, defaultLocale } = useActiveLocale()
	// An unset active language shows an empty box (the default text is the placeholder).
	const json = JSON.stringify({
		...value,
		[activeLocale]: value?.[activeLocale] ?? '',
	})
	const handle = useCallback(
		(next: string) => {
			try {
				onChange(JSON.parse(next) as LocalizedMap)
			} catch {
				/* the shared field always hands back JSON */
			}
		},
		[onChange],
	)
	return {
		json,
		handle,
		activeLocale,
		// While another language is active the default-language text is the hint.
		placeholderFrom:
			activeLocale !== defaultLocale
				? getLocalizedEditableValue(value ?? {}, defaultLocale, defaultLocale)
				: undefined,
	}
}

type MapFieldProps<T> = Omit<T, 'value' | 'onChange' | 'dir' | 'lang'> & {
	value: LocalizedMap | null | undefined
	onChange: (next: LocalizedMap) => void
}

/** One input over a language map; edits the active language. */
export function LocalizedMapInput({
	value,
	onChange,
	placeholder,
	...props
}: MapFieldProps<ComponentProps<typeof LocalizedInput>>) {
	const { json, handle, activeLocale, placeholderFrom } = useMapAdapter(
		value,
		onChange,
	)
	return (
		<LocalizedInput
			{...props}
			placeholder={placeholderFrom || placeholder}
			dir={getSiteLocaleDirection(activeLocale)}
			lang={activeLocale}
			value={json}
			onChange={handle}
		/>
	)
}

/** One textarea over a language map; edits the active language. */
export function LocalizedMapTextarea({
	value,
	onChange,
	placeholder,
	...props
}: MapFieldProps<ComponentProps<typeof LocalizedTextarea>>) {
	const { json, handle, activeLocale, placeholderFrom } = useMapAdapter(
		value,
		onChange,
	)
	return (
		<LocalizedTextarea
			{...props}
			placeholder={placeholderFrom || placeholder}
			dir={getSiteLocaleDirection(activeLocale)}
			lang={activeLocale}
			value={json}
			onChange={handle}
		/>
	)
}

/**
 * One line while a non-default language is active: which version is being
 * written and what guests see for anything left blank.
 */
export function WritingLanguageNote() {
	const { activeLocale, defaultLocale } = useActiveLocale()
	if (activeLocale === defaultLocale) return null
	const language = getSiteLocaleLabel(activeLocale)
	const fallback = getSiteLocaleLabel(defaultLocale)
	return (
		<p role="status" className="text-muted-foreground text-xs">
			<Trans>
				Writing the {language} version. Anything you leave blank is shown in{' '}
				{fallback}.
			</Trans>
		</p>
	)
}

/**
 * A labelled guest-facing field over a language map: the stock field chrome
 * (label, hint, inline error) around an input or textarea that edits the
 * active language.
 */
export function LocalizedMapField({
	label,
	hint,
	error,
	optional,
	multiline,
	id,
	value,
	onChange,
	...input
}: {
	label: ReactNode
	hint?: ReactNode
	error?: string | null
	optional?: boolean
	multiline?: boolean
	id?: string
	value: LocalizedMap | null | undefined
	onChange: (next: LocalizedMap) => void
} & Omit<
	ComponentProps<typeof LocalizedInput> &
		Pick<ComponentProps<typeof LocalizedTextarea>, 'rows'>,
	'value' | 'onChange' | 'dir' | 'lang' | 'id' | 'className'
>) {
	const generated = useId()
	const fieldId = id ?? generated
	const describedBy =
		[hint ? `${fieldId}-hint` : null, error ? `${fieldId}-error` : null]
			.filter(Boolean)
			.join(' ') || undefined
	const shared = {
		id: fieldId,
		'aria-invalid': error ? true : undefined,
		'aria-describedby': describedBy,
		value,
		onChange,
	}
	return (
		<Field data-invalid={error ? true : undefined}>
			<FieldLabel htmlFor={fieldId}>
				{label}
				{optional ? (
					<span className="text-muted-foreground font-normal">
						{' '}
						<Trans>(optional)</Trans>
					</span>
				) : null}
			</FieldLabel>
			{multiline ? (
				<LocalizedMapTextarea
					{...(input as ComponentProps<typeof LocalizedTextarea>)}
					{...shared}
				/>
			) : (
				<LocalizedMapInput {...input} {...shared} />
			)}
			{hint ? (
				<FieldDescription id={`${fieldId}-hint`}>{hint}</FieldDescription>
			) : null}
			{error ? <FieldError id={`${fieldId}-error`}>{error}</FieldError> : null}
		</Field>
	)
}
