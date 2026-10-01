import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { temporaryDirectory } from "../../../../test/temporary-directory";
import signing from "../../../../resources/release-signing.json" with { type: "json" };
import { validateWindowsSignature, verifyWindowsUpdateSignature } from "./windows-signature";

const file = "C:\\Users\\test\\update.exe";
const pinnedSignature = {
	path: file,
	trustStatus: 0x800b0109,
	certificateSha256: signing.certificateSha256,
	chainValid: true,
};

describe("Windows release signature policy", () => {
	it("trusts the pinned certificate while rejecting invalid digests, other issuers and invalid chains", () => {
		expect(validateWindowsSignature(pinnedSignature, file)).toBeNull();
		expect(validateWindowsSignature({ ...pinnedSignature, trustStatus: 0 }, file)).toBeNull();
		// Unknown failure, bad digest, unsigned file, explicit distrust, expiry and wrong key usage.
		for (const trustStatus of [1, 0x80096010, 0x800b0100, 0x800b0111, 0x800b0101, 0x800b0110])
			expect(validateWindowsSignature({ ...pinnedSignature, trustStatus }, file)).not.toBeNull();
		expect(validateWindowsSignature({ ...pinnedSignature, certificateSha256: "0".repeat(64) }, file)).not.toBeNull();
		expect(validateWindowsSignature({ ...pinnedSignature, chainValid: false }, file)).not.toBeNull();
		expect(validateWindowsSignature(pinnedSignature, "C:\\different.exe")).not.toBeNull();
		expect(() => validateWindowsSignature({}, file)).toThrow();
	});

	it.skipIf(process.platform !== "win32" || !process.env.LING_SIGNED_WINDOWS_APP)(
		"verifies the actual signed executable and rejects a modified copy without trusting its issuer system-wide",
		async () => {
			const app = process.env.LING_SIGNED_WINDOWS_APP!;
			expect(await verifyWindowsUpdateSignature([signing.publisher], app)).toBeNull();
			const root = await temporaryDirectory("windows-signature");
			onTestFinished(() => rm(root, { recursive: true, force: true }));
			const changed = join(root, "update ' 隔离.exe");
			const bytes = await readFile(app);
			// The DOS stub belongs to the Authenticode digest, outside its excluded checksum/certificate fields.
			bytes[0x40] = bytes[0x40]! ^ 1;
			await writeFile(changed, bytes);
			expect(await verifyWindowsUpdateSignature([signing.publisher], changed)).not.toBeNull();
		},
		60_000,
	);
});
