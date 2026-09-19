import { Trans } from '@lingui/macro'
import {
	getLocalizedEditableValue,
	type SiteLocalesConfig,
} from '@repo/common/site-locales'
import { Button } from '@repo/ui/button'
import {
	Frame,
	FrameDescription,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
import { PageHeader } from '@repo/ui/page-header'
import { type ReactNode, useContext, useMemo, useState } from 'react'
import { Link } from 'react-router'
import {
	LocalizedInput,
	LocalizedTextarea,
	LocaleContext,
	LocaleSwitcher,
} from '#app/components/website/locale-fields.tsx'

export function MenuResourceEditorPage({
	title,
	description,
	localesConfig,
	backHref,
	children,
	actions,
	sidebar,
}: {
	title: ReactNode
	description?: ReactNode
	localesConfig: SiteLocalesConfig
	backHref: string
	children: ReactNode
	actions?: ReactNode
	sidebar?: ReactNode
}) {
	const [activeLocale, setActiveLocale] = useState(localesConfig.defaultLocale)
	const localeValue = useMemo(
		() => ({
			activeLocale,
			defaultLocale: localesConfig.defaultLocale,
			locales: localesConfig.locales,
			setActiveLocale: (locale: string) =>
				setActiveLocale(locale as SiteLocalesConfig['defaultLocale']),
		}),
		[activeLocale, localesConfig],
	)

	return (
		<LocaleContext.Provider value={localeValue}>
			<div className="space-y-6">
				<PageHeader
					title={title}
					description={description}
					actions={
						<>
							<LocaleSwitcher />
							<Button variant="outline" render={<Link to={backHref} />}>
								<Trans>Back</Trans>
							</Button>
							{actions}
						</>
					}
				/>
				<div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
					<div className="min-w-0 space-y-6">{children}</div>
					{sidebar ? (
						<aside className="min-w-0 space-y-6">{sidebar}</aside>
					) : null}
				</div>
			</div>
		</LocaleContext.Provider>
	)
}

export function MenuEditorCard({
	title,
	description,
	children,
}: {
	title: ReactNode
	description?: ReactNode
	children: ReactNode
}) {
	return (
		<Frame>
			<FramePanel className="p-0">
				<FrameHeader>
					<FrameTitle className="font-semibold">{title}</FrameTitle>
					{description ? (
						<FrameDescription>{description}</FrameDescription>
					) : null}
				</FrameHeader>
				<div className="space-y-5 px-5 pb-5">{children}</div>
			</FramePanel>
		</Frame>
	)
}

export function MenuEditorSidebarCard({
	title,
	children,
}: {
	title: ReactNode
	children: ReactNode
}) {
	return (
		<Frame>
			<FramePanel className="p-0">
				<FrameHeader>
					<FrameTitle className="font-semibold">{title}</FrameTitle>
				</FrameHeader>
				<div className="space-y-3 px-5 pb-5">{children}</div>
			</FramePanel>
		</Frame>
	)
}

export function MenuLocalizedInput({
	label,
	value,
	onChange,
	name,
	required,
}: {
	label: ReactNode
	value: string
	onChange: (value: string) => void
	name: string
	required?: boolean
}) {
	const { defaultLocale } = useLocale()
	return (
		<div className="space-y-1.5">
			<label className="text-sm font-medium">
				{label}
				{required ? <span className="text-destructive"> *</span> : null}
			</label>
			<LocalizedInput value={value} onChange={onChange} required={required} />
			<input
				type="hidden"
				name={name}
				value={getLocalizedEditableValue(value, defaultLocale, defaultLocale)}
			/>
			<input type="hidden" name={`${name}I18n`} value={value} />
		</div>
	)
}

export function MenuLocalizedTextarea({
	label,
	value,
	onChange,
	name,
	rows = 4,
}: {
	label: ReactNode
	value: string
	onChange: (value: string) => void
	name: string
	rows?: number
}) {
	const { defaultLocale } = useLocale()
	return (
		<div className="space-y-1.5">
			<label className="text-sm font-medium">{label}</label>
			<LocalizedTextarea value={value} onChange={onChange} rows={rows} />
			<input
				type="hidden"
				name={name}
				value={getLocalizedEditableValue(value, defaultLocale, defaultLocale)}
			/>
			<input type="hidden" name={`${name}I18n`} value={value} />
		</div>
	)
}

function useLocale() {
	return useContext(LocaleContext)
}
