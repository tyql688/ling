import { describeSchedule, type Schedule } from "@ling/contracts/schedules";
import type { TFunction } from "i18next";

export function scheduleLabel(schedule: Schedule, t: TFunction, locale: string | undefined): string {
	return describeSchedule(schedule, locale, (key, count) => t(`schedules.${key}`, { count }));
}

export function dateLabel(time: number, locale: string | undefined): string {
	return new Date(time).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
