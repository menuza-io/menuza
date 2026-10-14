import { Trans } from '@lingui/macro'
import { getSiteLocaleLabel } from '@repo/common/site-locales'
import { cn } from '@repo/ui'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/field'
import { Input } from '@repo/ui/input'
import { type ReactNode, useContext, useId } from 'react'
import { LocaleContext } from '#app/components/website/locale-fields.tsx'
import { TranslateButton } from '#app/components/website/translate-provider.tsx'

/**
 * Hiring copy that job seekers read on the careers pages comes in the
 * organization's site languages, the same way menu items and website pages do:
 * the language switcher picks which one is being written, anything left blank
 * falls back to the default language, and AI translate fills a field from it.
 */

/** Whether a non-default language is being written. */
export function useTranslating() {
	const { activeLocale, defaultLocale } = useContext(LocaleContext)
	return {
		activeLocale,
		defaultLocale,
		translating: activeLocale !== defaultLocale,
	}
}

export function TranslatingNotice() {
	const { activeLocale, defaultLocale } = useTranslating()
	const language = getSiteLocaleLabel(activeLocale)
	const fallback = getSiteLocaleLabel(defaultLocale)
	return (
		<Alert role="status">
			<AlertDescription>
				<Trans>
					Writing the {language} version. Anything you leave blank is shown in{' '}
					{fallback}.
				</Trans>
			</AlertDescription>
		</Alert>
	)
}

/**
 * A text field for the language being written. While translating it shows the
 * default-language text as its placeholder and offers AI translate.
 */
export function LocalizedTextField({
	label,
	hint,
	error,
	value,
	fallback,
	onChange,
	maxLength,
	className,
}: {
	label: ReactNode
	hint?: ReactNode
	error?: string | null
	/** The text in the language being written. */
	value: string
	/** The default-language text, shown while translating. */
	fallback: string
	onChange: (value: string) => void
	maxLength?: number
	className?: string
}) {
	const id = useId()
	const { activeLocale, translating } = useTranslating()
	const describedBy =
		[hint ? `${id}-hint` : null, error ? `${id}-error` : null]
			.filter(Boolean)
			.join(' ') || undefined
	return (
		<Field className={className} data-invalid={error ? true : undefined}>
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			<div className="relative">
				<Input
					id={id}
					key={activeLocale}
					value={value}
					maxLength={maxLength}
					placeholder={translating ? fallback : undefined}
					dir={translating ? 'auto' : undefined}
					aria-invalid={error ? true : undefined}
					aria-describedby={describedBy}
					className={cn(translating && 'pe-10')}
					onChange={(event) => onChange(event.target.value)}
				/>
				{translating ? (
					<TranslateButton
						textToTranslate={fallback}
						onTranslate={onChange}
						className="absolute end-2 top-1/2 -translate-y-1/2"
					/>
				) : null}
			</div>
			{hint ? (
				<FieldDescription id={`${id}-hint`}>{hint}</FieldDescription>
			) : null}
			{error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
		</Field>
	)
}
