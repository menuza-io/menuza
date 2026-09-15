import { Trans } from '@lingui/macro'
import { cn } from '@repo/ui'
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@repo/ui/alert-dialog'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Spinner } from '@repo/ui/spinner'
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
	type ReactNode,
} from 'react'
import { useFetcher, useParams } from 'react-router'
import { toast } from 'sonner'
import { parseBlockConfig } from '#app/utils/website/block-types.ts'
import {
	BULK_UPDATE_SECTIONS_INTENT,
	collectTranslationFields,
	getTranslatedConfig,
	type TranslateItem,
} from '#app/utils/website/translation.ts'

type SectionInput = {
	id: string
	type: string
	config: Record<string, unknown>
}

type TranslateMode = 'all' | 'untranslated'

type TranslateApply = (
	translations: Array<{ id: string; text: string }>,
) => void | Promise<void>

type PendingTranslate = {
	items: TranslateItem[]
	apply: TranslateApply
}

type TranslateContextValue = {
	activeLocale: string
	defaultLocale: string
	isTranslating: boolean
	requestTranslate: (sections: SectionInput[]) => void
	requestTranslateItems: (items: TranslateItem[], apply: TranslateApply) => void
}

const TranslateContext = createContext<TranslateContextValue | null>(null)

export function useSectionTranslator() {
	const value = useContext(TranslateContext)
	if (!value) {
		throw new Error(
			'useSectionTranslator must be used within TranslateProvider',
		)
	}
	return value
}

async function requestTranslations(
	orgSlug: string,
	texts: string[],
	sourceLang: string,
	targetLang: string,
	allowHtmlFlags: boolean[],
): Promise<string[]> {
	const response = await fetch('/api/translate', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			orgSlug,
			text: texts,
			sourceLang,
			targetLang,
			allowHtml: allowHtmlFlags,
		}),
	})

	if (!response.ok) {
		throw new Error('Failed to translate')
	}

	const data = (await response.json()) as { translation?: string | string[] }
	const translations = data.translation
	if (!Array.isArray(translations) || translations.length !== texts.length) {
		throw new Error('Failed to translate')
	}
	return translations
}

export function TranslateProvider({
	activeLocale,
	defaultLocale,
	children,
}: {
	activeLocale: string
	defaultLocale: string
	children: ReactNode
}) {
	const params = useParams()
	const orgSlug = params.orgSlug ?? ''
	const [isTranslating, setIsTranslating] = useState(false)
	const [pending, setPending] = useState<PendingTranslate | null>(null)
	const bulkUpdateFetcher = useFetcher()

	const applyItems = useCallback(
		async (items: TranslateItem[], apply: TranslateApply) => {
			if (items.length === 0 || activeLocale === defaultLocale) return
			if (!orgSlug) return

			setIsTranslating(true)
			try {
				const translations = await requestTranslations(
					orgSlug,
					items.map((item) => item.defaultText),
					defaultLocale,
					activeLocale,
					items.map((item) => item.allowHtml),
				)
				const results: Array<{ id: string; text: string }> = []
				for (const [index, item] of items.entries()) {
					const text = translations[index]
					if (!text) continue
					results.push({ id: item.id, text })
				}
				await apply(results)
			} catch {
				toast.error('Failed to translate. Please try again.')
			} finally {
				setIsTranslating(false)
			}
		},
		[activeLocale, defaultLocale, orgSlug],
	)

	const requestTranslateItems = useCallback(
		(items: TranslateItem[], apply: TranslateApply) => {
			if (activeLocale === defaultLocale) return
			if (items.length === 0) {
				toast.info('Nothing to translate in this locale.')
				return
			}
			if (items.some((item) => item.hasCustomTranslation)) {
				setPending({ items, apply })
				return
			}
			void applyItems(items, apply)
		},
		[activeLocale, applyItems, defaultLocale],
	)

	const requestTranslate = useCallback(
		(sections: SectionInput[]) => {
			const fields = collectTranslationFields(
				sections,
				defaultLocale,
				activeLocale,
			)
			requestTranslateItems(fields, async (translations) => {
				const textById = new Map(
					translations.map((item) => [item.id, item.text]),
				)
				const updatedSectionsMap = new Map<string, Record<string, unknown>>()
				for (const section of sections) {
					updatedSectionsMap.set(section.id, section.config)
				}

				for (const field of fields) {
					const translatedText = textById.get(field.id)
					if (!translatedText) continue
					const currentConfig = updatedSectionsMap.get(field.sectionId)
					if (!currentConfig) continue
					updatedSectionsMap.set(
						field.sectionId,
						getTranslatedConfig(
							currentConfig,
							field.type,
							{ [field.path]: translatedText },
							activeLocale,
							defaultLocale,
						),
					)
				}

				const updates = Array.from(updatedSectionsMap.entries()).map(
					([id, config]) => ({
						id,
						config: JSON.stringify(config),
					}),
				)

				void bulkUpdateFetcher.submit(
					{
						intent: BULK_UPDATE_SECTIONS_INTENT,
						sections: JSON.stringify(updates),
					},
					{ method: 'POST' },
				)
			})
		},
		[activeLocale, bulkUpdateFetcher, defaultLocale, requestTranslateItems],
	)

	const confirmPending = (mode: TranslateMode) => {
		if (!pending) return
		const selected =
			mode === 'all'
				? pending.items
				: pending.items.filter((item) => !item.hasCustomTranslation)
		const apply = pending.apply
		setPending(null)
		void applyItems(selected, apply)
	}

	return (
		<TranslateContext.Provider
			value={{
				activeLocale,
				defaultLocale,
				isTranslating,
				requestTranslate,
				requestTranslateItems,
			}}
		>
			{children}
			<AlertDialog
				open={pending !== null}
				onOpenChange={(open) => {
					if (!open) setPending(null)
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Some fields are already translated</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								Some fields already differ from the default language. Translate
								everything, or only the fields that still match the default?
							</Trans>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							<Trans>Cancel</Trans>
						</AlertDialogCancel>
						<Button
							type="button"
							variant="outline"
							onClick={() => confirmPending('untranslated')}
						>
							<Trans>Untranslated only</Trans>
						</Button>
						<AlertDialogAction onClick={() => confirmPending('all')}>
							<Trans>Translate all</Trans>
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</TranslateContext.Provider>
	)
}

export function TranslateAllButton({
	sections,
}: {
	sections: Array<{ id: string; type: string; config: string }>
}) {
	const { requestTranslate, isTranslating, activeLocale, defaultLocale } =
		useSectionTranslator()

	if (activeLocale === defaultLocale || sections.length === 0) return null

	return (
		<Button
			variant="ghost"
			size="xs"
			className="text-primary hover:bg-primary/10 hover:text-primary"
			onClick={() =>
				requestTranslate(
					sections.map((section) => ({
						id: section.id,
						type: section.type,
						config: parseBlockConfig(section.config),
					})),
				)
			}
			disabled={isTranslating}
			title={`Translate all sections to ${activeLocale}`}
		>
			{isTranslating ? (
				<Spinner className="mr-1 size-3.5" />
			) : (
				<Icon name="languages" className="mr-1 size-3.5" />
			)}
			<Trans>Translate All</Trans>
		</Button>
	)
}

export function TranslateItemsButton({
	items,
	onApply,
}: {
	items: TranslateItem[]
	onApply: TranslateApply
}) {
	const { requestTranslateItems, isTranslating, activeLocale, defaultLocale } =
		useSectionTranslator()

	if (activeLocale === defaultLocale || items.length === 0) return null

	return (
		<Button
			type="button"
			variant="ghost"
			size="xs"
			className="text-primary hover:bg-primary/10 hover:text-primary"
			onClick={() => requestTranslateItems(items, onApply)}
			disabled={isTranslating}
			title={`Translate all fields to ${activeLocale}`}
		>
			{isTranslating ? (
				<Spinner className="mr-1 size-3.5" />
			) : (
				<Icon name="languages" className="mr-1 size-3.5" />
			)}
			<Trans>Translate All</Trans>
		</Button>
	)
}

export function TranslateButton({
	textToTranslate,
	onTranslate,
	className,
	allowHtml = false,
}: {
	textToTranslate: string
	onTranslate: (translated: string) => void
	className?: string
	allowHtml?: boolean
}) {
	const { activeLocale, defaultLocale } = useSectionTranslator()
	const params = useParams()
	const orgSlug = params.orgSlug ?? ''
	const fetcher = useFetcher<{ translation?: string; error?: string }>()
	const processedDataRef = useRef<{
		translation?: string
		error?: string
	} | null>(null)

	const handleTranslate = () => {
		if (!textToTranslate || !orgSlug) return
		void fetcher.submit(
			{
				orgSlug,
				text: textToTranslate,
				sourceLang: defaultLocale,
				targetLang: activeLocale,
				allowHtml,
			},
			{ method: 'POST', action: '/api/translate', encType: 'application/json' },
		)
	}

	useEffect(() => {
		if (
			fetcher.data?.translation &&
			fetcher.data !== processedDataRef.current
		) {
			processedDataRef.current = fetcher.data
			onTranslate(fetcher.data.translation)
		}
	}, [fetcher.data, onTranslate])

	if (activeLocale === defaultLocale) return null

	return (
		<Button
			type="button"
			variant="ghost"
			size="icon"
			className={cn(
				'text-muted-foreground hover:text-foreground h-5 w-5',
				className,
			)}
			onClick={handleTranslate}
			disabled={fetcher.state !== 'idle' || !textToTranslate}
			title={`Translate from ${defaultLocale} to ${activeLocale}`}
		>
			{fetcher.state !== 'idle' ? (
				<Spinner className="size-3" />
			) : (
				<Icon name="languages" className="size-3" />
			)}
		</Button>
	)
}
