import { type MessageDescriptor } from '@lingui/core'
import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { useEffect, useState } from 'react'
import {
	DISCOUNT_MAX_CODES,
	type CodeRow,
	type EditorErrors,
	generateCode,
	newCodeKey,
} from '#app/utils/discounts/editor-model.ts'
import { ANNOUNCE } from '#app/utils/discounts/labels.ts'
import {
	FieldErrorText,
	RowLabel,
	fieldDomId,
	useEditorErrorText,
} from './fields.tsx'

/** The coupon codes of a discount, each with an optional use limit. */
export function CodesEditor({
	codes,
	onChange,
	errors,
}: {
	codes: readonly CodeRow[]
	onChange: (codes: CodeRow[]) => void
	errors: EditorErrors
}) {
	const { t, i18n } = useLingui()
	const tx = (descriptor: MessageDescriptor) => i18n._(descriptor)
	const errorText = useEditorErrorText()
	const [focusIndex, setFocusIndex] = useState<number | null>(null)
	const [announcement, setAnnouncement] = useState('')
	useEffect(() => {
		if (focusIndex === null) return
		document.getElementById(fieldDomId(`codes.${focusIndex}.code`))?.focus()
		setFocusIndex(null)
	}, [focusIndex, codes.length])
	const full = codes.length >= DISCOUNT_MAX_CODES
	const update = (index: number, patch: Partial<CodeRow>) =>
		onChange(codes.map((row, i) => (i === index ? { ...row, ...patch } : row)))
	const add = (code = '', maxUses = '') => {
		if (full) return
		onChange([...codes, { key: newCodeKey(), id: null, code, maxUses }])
		setFocusIndex(codes.length)
		setAnnouncement(ANNOUNCE.codeAdded(codes.length + 1, tx))
	}
	const remove = (index: number) => {
		onChange(codes.filter((_, i) => i !== index))
		setAnnouncement(ANNOUNCE.codeRemoved(codes.length - 1, tx))
		// Keep focus in the list: the row before, or the first one, or Add.
		if (codes.length > 1) setFocusIndex(Math.max(0, index - 1))
		else document.getElementById('discount-codes-add')?.focus()
	}
	const addSingleUse = (count: number) => {
		const room = Math.max(0, DISCOUNT_MAX_CODES - codes.length)
		const made = Math.min(count, room)
		const next = [...codes]
		for (let index = 0; index < made; index += 1) {
			next.push({
				key: newCodeKey(),
				id: null,
				code: generateCode(),
				maxUses: '1',
			})
		}
		onChange(next)
		if (made > 0) {
			setFocusIndex(codes.length)
			setAnnouncement(ANNOUNCE.singleUseAdded(made, next.length, tx))
		}
	}

	return (
		<div
			id={fieldDomId('codes')}
			tabIndex={-1}
			className="flex flex-col gap-3 outline-none"
		>
			{codes.length === 0 ? (
				<p className="text-muted-foreground text-sm">
					<Trans>
						No codes yet. Customers type a code at checkout to get this
						discount. Without a code here, it only works with the unique codes
						you send in Marketing broadcasts and automations.
					</Trans>
				</p>
			) : null}
			<ul className="flex flex-col gap-3">
				{codes.map((row, index) => {
					const codeField = `codes.${index}.code`
					const usesField = `codes.${index}.maxUses`
					const codeError = errors[codeField]
					const usesError = errors[usesField]
					const typedCode = row.code.trim()
					const number = index + 1
					const codeId = fieldDomId(codeField)
					const usesId = fieldDomId(usesField)
					return (
						<li key={row.key} className="flex flex-col gap-1">
							<div className="flex flex-wrap items-end gap-2">
								<div className="flex min-w-40 flex-1 flex-col gap-1.5">
									<Label htmlFor={codeId}>
										<RowLabel
											short={<Trans>Code</Trans>}
											full={<Trans>Code {number}</Trans>}
										/>
									</Label>
									<Input
										id={codeId}
										value={row.code}
										onChange={(event) =>
											update(index, { code: event.target.value })
										}
										autoCapitalize="characters"
										autoComplete="off"
										spellCheck={false}
										maxLength={40}
										dir="ltr"
										className="font-mono uppercase"
										aria-invalid={codeError ? true : undefined}
										aria-describedby={codeError ? `${codeId}-error` : undefined}
									/>
								</div>
								<div className="flex w-36 flex-col gap-1.5">
									<Label htmlFor={usesId}>
										<RowLabel
											short={<Trans>Use limit</Trans>}
											full={<Trans>Use limit for code {number}</Trans>}
										/>
									</Label>
									<Input
										id={usesId}
										value={row.maxUses}
										onChange={(event) =>
											update(index, { maxUses: event.target.value })
										}
										inputMode="numeric"
										placeholder={t`Unlimited`}
										dir="ltr"
										aria-invalid={usesError ? true : undefined}
										aria-describedby={usesError ? `${usesId}-error` : undefined}
									/>
								</div>
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									aria-label={
										row.code.trim()
											? t`Remove code ${typedCode}`
											: t`Remove this code`
									}
									onClick={() => remove(index)}
								>
									<Icon name="trash-2" />
								</Button>
							</div>
							{codeError ? (
								<FieldErrorText id={`${codeId}-error`}>
									{errorText(codeError)}
								</FieldErrorText>
							) : null}
							{usesError ? (
								<FieldErrorText id={`${usesId}-error`}>
									{errorText(usesError)}
								</FieldErrorText>
							) : null}
						</li>
					)
				})}
			</ul>
			{errors.codes ? (
				<FieldErrorText id={`${fieldDomId('codes')}-error`}>
					{errorText(errors.codes)}
				</FieldErrorText>
			) : null}
			<p role="status" className="sr-only">
				{announcement}
			</p>
			<div className="flex flex-wrap gap-2">
				<Button
					id="discount-codes-add"
					type="button"
					variant="outline"
					size="sm"
					disabled={full}
					onClick={() => add()}
				>
					<Icon name="plus" data-icon="inline-start" />
					<Trans>Add a code</Trans>
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					disabled={full}
					onClick={() => add(generateCode())}
				>
					<Icon name="sparkles" data-icon="inline-start" />
					<Trans>Generate a code</Trans>
				</Button>
				{[10, 25, 50].map((count) => (
					<Button
						key={count}
						type="button"
						variant="ghost"
						size="sm"
						disabled={full}
						onClick={() => addSingleUse(count)}
					>
						<Plural
							value={count}
							one="Generate # single-use code"
							other="Generate # single-use codes"
						/>
					</Button>
				))}
			</div>
		</div>
	)
}
