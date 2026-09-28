import { describe, expect, it } from "vitest";
import {
	DEFAULT_GEOMETRY,
	defaultRightWidth,
	parseWorkbenchGeometry,
	rightColumnWidth,
	withRightWidth,
} from "./workbench-geometry";

describe("workbench column geometry", () => {
	it("keeps a version 1 conversation width as the preference until a ratio replaces it", () => {
		const migrated = parseWorkbenchGeometry({ version: 1, conversation: 466, sidebar: 270 });
		expect(migrated).toEqual({
			version: 2,
			rightRatio: null,
			legacyConversation: 466,
			sidebar: 270,
			readingOnLeft: false,
		});
		expect(rightColumnWidth(migrated!, 1086, 811)).toBe(620);
		const dragged = withRightWidth(migrated!, 500, 1086);
		expect(dragged.legacyConversation).toBeNull();
		expect(rightColumnWidth(dragged, 1086, 811)).toBe(500);
	});
	it("defaults to a conversation of about 500px, capped at a 16:10 box of the height", () => {
		expect(defaultRightWidth(1086, 811)).toBe(640);
		expect(defaultRightWidth(1460, 1005)).toBe(960);
		expect(rightColumnWidth(DEFAULT_GEOMETRY, 2288, 856)).toBe(1370);
	});
	it("keeps the dragged split proportional when the window resizes", () => {
		const dragged = withRightWidth(DEFAULT_GEOMETRY, 500, 1086);
		const narrow = rightColumnWidth(dragged, 1086, 811);
		const wide = rightColumnWidth(dragged, 1400, 811);
		expect(narrow).toBe(500);
		expect((wide - 320) / (1400 - 352 - 320)).toBeCloseTo((narrow - 320) / (1086 - 352 - 320), 2);
	});
	it("keeps both minimums on narrow windows", () => {
		expect(rightColumnWidth(DEFAULT_GEOMETRY, 600, 700)).toBe(320);
		expect(rightColumnWidth(withRightWidth(DEFAULT_GEOMETRY, 5000, 1086), 1086, 811)).toBe(1086 - 352);
	});
	it("restores pane order without changing either pane's width preference", () => {
		const previous = { version: 2, rightRatio: 0.4, legacyConversation: null, sidebar: 300 };
		expect(parseWorkbenchGeometry(previous)?.readingOnLeft).toBe(false);
		const swapped = parseWorkbenchGeometry({ ...previous, readingOnLeft: true })!;
		expect(swapped.readingOnLeft).toBe(true);
		expect(rightColumnWidth(swapped, 1400, 811)).toBe(
			rightColumnWidth({ ...swapped, readingOnLeft: false }, 1400, 811),
		);
		expect(withRightWidth(swapped, 700, 1400).readingOnLeft).toBe(true);
		expect(parseWorkbenchGeometry({ ...previous, readingOnLeft: "left" })).toBeNull();
	});

	it("rejects stored shapes outside the supported versions and bounds", () => {
		expect(parseWorkbenchGeometry({ version: 3, rightRatio: 0.5, legacyConversation: null, sidebar: 280 })).toBeNull();
		expect(parseWorkbenchGeometry({ version: 2, rightRatio: 1.5, legacyConversation: null, sidebar: 280 })).toBeNull();
		expect(parseWorkbenchGeometry({ version: 1, conversation: 120, sidebar: 280 })).toBeNull();
		expect(parseWorkbenchGeometry({ version: 2, rightRatio: null, legacyConversation: null, sidebar: 900 })).toBeNull();
	});
});
