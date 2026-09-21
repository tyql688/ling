import { useCallback, useState } from "react";

export function useBoundedTextInput(setValue: (value: string) => void, maxLength: number) {
	const [limitExceeded, setLimitExceeded] = useState(false);
	const resetLimitExceeded = useCallback(() => setLimitExceeded(false), []);
	const reportLimitExceeded = useCallback(() => setLimitExceeded(true), []);

	const setBoundedValue = useCallback(
		(value: string): boolean => {
			if (value.length > maxLength) {
				setLimitExceeded(true);
				return false;
			}
			setLimitExceeded(false);
			setValue(value);
			return true;
		},
		[maxLength, setValue],
	);

	return { limitExceeded, resetLimitExceeded, reportLimitExceeded, setBoundedValue };
}
