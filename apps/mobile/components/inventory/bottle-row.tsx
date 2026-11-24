import { Trans, useLingui } from '@lingui/react/macro'
import {
	BOTTLE_TENTHS_MAX,
	bottlesToMl,
	canCountByWeight,
	type ItemBottle,
	mlToBottleParts,
	openBottleMlFromWeight,
} from '@repo/inventory'
import React, { useState } from 'react'
import { Text, TextInput, TouchableOpacity, View } from 'react-native'

const TENTHS = Array.from({ length: BOTTLE_TENTHS_MAX + 1 }, (_, i) => i)

/**
 * Counting an open bottle on the phone (#470): whole full bottles with − and +,
 * the open bottle as one of eleven tenths (0 to 1) or, when the item knows its
 * full and empty weight, typed from the scale. The answer is millilitres, the
 * same amount any count entry holds. No scale connection: weight is typed.
 */
export function BottleRow({
	bottle,
	valueMl,
	onValueMl,
}: {
	bottle: ItemBottle
	valueMl: number | null
	onValueMl: (ml: number) => void
}) {
	const { t } = useLingui()
	const initial = mlToBottleParts(bottle, valueMl ?? 0)
	const [whole, setWhole] = useState(initial.whole)
	const [tenths, setTenths] = useState(initial.openTenths)
	const [byWeight, setByWeight] = useState(false)
	const [weight, setWeight] = useState('')
	const weighable = canCountByWeight(bottle)

	function emit(next: { whole: number; tenths: number; weight: string }) {
		if (byWeight) {
			const grams = Number(next.weight.replace(',', '.'))
			const open =
				next.weight.trim() === '' || !Number.isFinite(grams)
					? 0
					: (openBottleMlFromWeight(bottle, Math.max(0, grams)) ?? 0)
			onValueMl(bottlesToMl(bottle, next.whole, 0) + open)
		} else {
			onValueMl(bottlesToMl(bottle, next.whole, next.tenths))
		}
	}

	return (
		<View className="mt-2 gap-2" testID="bottle-row">
			<View className="flex-row items-center gap-3">
				<Text className="text-muted-foreground text-xs">
					<Trans>Full bottles</Trans>
				</Text>
				<TouchableOpacity
					onPress={() => {
						const next = Math.max(0, whole - 1)
						setWhole(next)
						emit({ whole: next, tenths, weight })
					}}
					accessibilityRole="button"
					accessibilityLabel={t`Fewer bottles`}
					className="border-border h-11 w-11 items-center justify-center rounded-lg border"
					testID="bottle-less"
				>
					<Text className="text-foreground text-xl">−</Text>
				</TouchableOpacity>
				<Text
					className="text-foreground w-8 text-center text-lg"
					testID="bottle-whole"
				>
					{whole}
				</Text>
				<TouchableOpacity
					onPress={() => {
						const next = whole + 1
						setWhole(next)
						emit({ whole: next, tenths, weight })
					}}
					accessibilityRole="button"
					accessibilityLabel={t`More bottles`}
					className="border-border h-11 w-11 items-center justify-center rounded-lg border"
					testID="bottle-more"
				>
					<Text className="text-foreground text-xl">+</Text>
				</TouchableOpacity>
			</View>
			{byWeight ? (
				<View className="flex-row items-center gap-3">
					<Text className="text-muted-foreground text-xs">
						<Trans>Open bottle weight (g)</Trans>
					</Text>
					<TextInput
						value={weight}
						onChangeText={(text) => {
							setWeight(text)
							emit({ whole, tenths, weight: text })
						}}
						keyboardType="decimal-pad"
						accessibilityLabel={t`Open bottle weight in grams`}
						className="border-border text-foreground h-11 w-28 rounded-lg border px-3"
						testID="bottle-weight"
					/>
				</View>
			) : (
				<View
					className="flex-row flex-wrap gap-1.5"
					accessibilityRole="radiogroup"
				>
					{TENTHS.map((tenth) => (
						<TouchableOpacity
							key={tenth}
							onPress={() => {
								setTenths(tenth)
								emit({ whole, tenths: tenth, weight })
							}}
							accessibilityRole="radio"
							accessibilityState={{ checked: tenth === tenths }}
							className={`h-11 min-w-11 items-center justify-center rounded-lg border px-2 ${
								tenth === tenths ? 'bg-primary border-primary' : 'border-border'
							}`}
							testID={`bottle-tenth-${tenth}`}
						>
							<Text
								className={
									tenth === tenths
										? 'text-primary-foreground'
										: 'text-foreground'
								}
							>
								{(tenth / BOTTLE_TENTHS_MAX).toFixed(1)}
							</Text>
						</TouchableOpacity>
					))}
				</View>
			)}
			{weighable ? (
				<TouchableOpacity
					onPress={() => setByWeight((on) => !on)}
					accessibilityRole="button"
					className="self-start py-1"
					testID="bottle-mode"
				>
					<Text className="text-primary text-sm">
						{byWeight ? (
							<Trans>Count in tenths</Trans>
						) : (
							<Trans>Count by weight</Trans>
						)}
					</Text>
				</TouchableOpacity>
			) : null}
		</View>
	)
}
