import {
	getLocalizedEditableValue,
	getSiteLocaleLabel,
} from '@repo/common/site-locales'
import { cn } from '@repo/ui'
import { Input } from '@repo/ui/input'
import { Textarea } from '@repo/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@repo/ui/tooltip'
import { createContext, useContext, useRef, type ComponentProps } from 'react'
import { TranslateButton } from '#app/components/website/translate-provider.tsx'

export const LocaleContext = createContext<{
	activeLocale: string
	defaultLocale: string
	locales: string[]
	setActiveLocale: (locale: string) => void
}>({
	activeLocale: 'en',
	defaultLocale: 'en',
	locales: ['en'],
	setActiveLocale: () => {},
})

export function LocaleSwitcher({ className }: { className?: string }) {
	const { activeLocale, locales, setActiveLocale } = useContext(LocaleContext)
	const codesRef = useRef<HTMLDivElement>(null)

	if (locales.length < 2) return null

	const focusLocale = (locale: string) => {
		codesRef.current
			?.querySelector<HTMLButtonElement>(`[data-locale="${locale}"]`)
			?.focus()
	}

	return (
		<div
			role="radiogroup"
			aria-label="Content language"
			className={cn('flex max-w-[45%] min-w-0 items-center gap-1', className)}
			onKeyDown={(event) => {
				if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
				event.preventDefault()
				const index = locales.indexOf(activeLocale)
				const delta = event.key === 'ArrowRight' ? 1 : -1
				const next = locales[(index + delta + locales.length) % locales.length]
				if (!next) return
				setActiveLocale(next)
				focusLocale(next)
			}}
		>
			<div
				ref={codesRef}
				className="flex min-w-0 scrollbar-none items-center overflow-x-auto [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
			>
				{locales.map((locale) => {
					const selected = locale === activeLocale
					const label = getSiteLocaleLabel(locale)
					return (
						<Tooltip key={locale}>
							<TooltipTrigger
								render={
									<button
										type="button"
										role="radio"
										data-locale={locale}
										tabIndex={selected ? 0 : -1}
										aria-checked={selected}
										aria-label={label}
										onClick={() => setActiveLocale(locale)}
										className={cn(
											'h-6 min-w-6 shrink-0 rounded-md px-1.5 text-[11px] tracking-wide uppercase transition-colors duration-150',
											'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
											selected
												? 'bg-muted text-foreground'
												: 'text-muted-foreground hover:text-foreground',
										)}
									>
										{locale}
									</button>
								}
							/>
							<TooltipContent>{label}</TooltipContent>
						</Tooltip>
					)
				})}
			</div>
		</div>
	)
}

export function updateLocalizedValue(
	prevValue: string | undefined,
	newValue: string,
	activeLocale: string,
	defaultLocale: string,
): string {
	const currentStr = prevValue ?? ''
	let map: Record<string, string> = {}
	if (currentStr && currentStr.startsWith('{')) {
		try {
			map = JSON.parse(currentStr) as Record<string, string>
		} catch {
			map = { [defaultLocale]: currentStr }
		}
	} else if (currentStr) {
		map = { [defaultLocale]: currentStr }
	}
	map[activeLocale] = newValue
	return JSON.stringify(map)
}

export function LocalizedInput({
	value,
	onChange,
	allowHtml = false,
	...props
}: Omit<ComponentProps<typeof Input>, 'value' | 'onChange'> & {
	value: string
	onChange: (value: string) => void
	allowHtml?: boolean
}) {
	const { activeLocale, defaultLocale } = useContext(LocaleContext)
	const displayValue = getLocalizedEditableValue(
		value,
		activeLocale,
		defaultLocale,
	)
	const defaultLocaleValue = getLocalizedEditableValue(
		value,
		defaultLocale,
		defaultLocale,
	)

	return (
		<div className="relative w-full">
			<Input
				{...props}
				value={displayValue}
				onChange={(e) =>
					onChange(
						updateLocalizedValue(
							value,
							e.target.value,
							activeLocale,
							defaultLocale,
						),
					)
				}
				className={cn(
					props.className,
					activeLocale !== defaultLocale ? 'pr-8' : '',
				)}
			/>
			{activeLocale !== defaultLocale && (
				<TranslateButton
					textToTranslate={defaultLocaleValue}
					allowHtml={allowHtml}
					onTranslate={(translated) =>
						onChange(
							updateLocalizedValue(
								value,
								translated,
								activeLocale,
								defaultLocale,
							),
						)
					}
					className="absolute top-1/2 right-1.5 -translate-y-1/2"
				/>
			)}
		</div>
	)
}

export function LocalizedTextarea({
	value,
	onChange,
	allowHtml = false,
	...props
}: Omit<ComponentProps<typeof Textarea>, 'value' | 'onChange'> & {
	value: string
	onChange: (value: string) => void
	allowHtml?: boolean
}) {
	const { activeLocale, defaultLocale } = useContext(LocaleContext)
	const displayValue = getLocalizedEditableValue(
		value,
		activeLocale,
		defaultLocale,
	)
	const defaultLocaleValue = getLocalizedEditableValue(
		value,
		defaultLocale,
		defaultLocale,
	)

	return (
		<div className="relative w-full">
			<Textarea
				{...props}
				value={displayValue}
				onChange={(e) =>
					onChange(
						updateLocalizedValue(
							value,
							e.target.value,
							activeLocale,
							defaultLocale,
						),
					)
				}
				className={cn(
					props.className,
					activeLocale !== defaultLocale ? 'pr-8' : '',
				)}
			/>
			{activeLocale !== defaultLocale && (
				<TranslateButton
					textToTranslate={defaultLocaleValue}
					allowHtml={allowHtml}
					onTranslate={(translated) =>
						onChange(
							updateLocalizedValue(
								value,
								translated,
								activeLocale,
								defaultLocale,
							),
						)
					}
					className="absolute top-2 right-1.5"
				/>
			)}
		</div>
	)
}
