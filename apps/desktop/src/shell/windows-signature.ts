import { execFile } from "node:child_process";
import { join, win32 } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import signing from "../../../../resources/release-signing.json" with { type: "json" };

const execute = promisify(execFile);

/** Read the signer from the same native verification state that validates the executable digest. */
const VERIFY_SIGNATURE = String.raw`
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

public static class LingAuthenticode {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct FileInfo {
    public uint cbStruct;
    [MarshalAs(UnmanagedType.LPWStr)] public string path;
    public IntPtr handle, knownSubject;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct TrustData {
    public uint cbStruct;
    public IntPtr policyCallback, sipClientData;
    public uint uiChoice, revocationChecks, unionChoice;
    public IntPtr fileInfo;
    public uint stateAction;
    public IntPtr stateData, urlReference;
    public uint providerFlags, uiContext;
    public IntPtr signatureSettings;
  }

  // Only the leading fields of CRYPT_PROVIDER_CERT are read.
  [StructLayout(LayoutKind.Sequential)]
  private struct ProviderCertificate {
    public uint cbStruct;
    public IntPtr certificate;
  }

  [DllImport("wintrust.dll", ExactSpelling = true)]
  [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
  private static extern uint WinVerifyTrust(IntPtr window, ref Guid action, ref TrustData data);
  [DllImport("wintrust.dll", ExactSpelling = true)]
  [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
  private static extern IntPtr WTHelperProvDataFromStateData(IntPtr state);
  [DllImport("wintrust.dll", ExactSpelling = true)]
  [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
  private static extern IntPtr WTHelperGetProvSignerFromChain(IntPtr provider, uint index,
    [MarshalAs(UnmanagedType.Bool)] bool counterSigner, uint counterIndex);
  [DllImport("wintrust.dll", ExactSpelling = true)]
  [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
  private static extern IntPtr WTHelperGetProvCertFromChain(IntPtr signer, uint index);

  public sealed class Result {
    public string path;
    public uint trustStatus;
    public string certificateSha256;
    public bool chainValid;
  }

  public static Result Verify(string path) {
    var result = new Result { path = Path.GetFullPath(path) };
    // Keep the file immutable while the digest and its signer are being inspected.
    using (var file = new FileStream(result.path, FileMode.Open, FileAccess.Read, FileShare.Read)) {
      var info = new FileInfo {
        cbStruct = (uint)Marshal.SizeOf(typeof(FileInfo)), path = result.path,
        handle = file.SafeFileHandle.DangerousGetHandle()
      };
      var data = new TrustData {
        cbStruct = (uint)Marshal.SizeOf(typeof(TrustData)),
        uiChoice = 2, unionChoice = 1, stateAction = 1,
        // The pinned self-signed issuer has no revocation authority. Verification stays offline.
        providerFlags = 0x10 | 0x1000,
        fileInfo = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(FileInfo)))
      };
      var action = new Guid("00AAC56B-CD44-11D0-8CC2-00C04FC295EE");
      Marshal.StructureToPtr(info, data.fileInfo, false);
      try {
        result.trustStatus = WinVerifyTrust(new IntPtr(-1), ref action, ref data);
        // CERT_E_UNTRUSTEDROOT is the only trust failure permitted for the pinned issuer.
        if (result.trustStatus != 0 && result.trustStatus != 0x800B0109) return result;
        var provider = WTHelperProvDataFromStateData(data.stateData);
        if (provider == IntPtr.Zero) return result;
        var signer = WTHelperGetProvSignerFromChain(provider, 0, false, 0);
        if (signer == IntPtr.Zero) return result;
        var entry = WTHelperGetProvCertFromChain(signer, 0);
        if (entry == IntPtr.Zero) return result;
        var context = (ProviderCertificate)Marshal.PtrToStructure(entry, typeof(ProviderCertificate));
        if (context.certificate == IntPtr.Zero) return result;
        using (var certificate = new X509Certificate2(context.certificate))
        using (var hash = SHA256.Create())
        using (var chain = new X509Chain()) {
          result.certificateSha256 = BitConverter.ToString(hash.ComputeHash(certificate.RawData)).Replace("-", "");
          chain.ChainPolicy.VerificationFlags = X509VerificationFlags.AllowUnknownCertificateAuthority;
          chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
          chain.ChainPolicy.ApplicationPolicy.Add(new Oid("1.3.6.1.5.5.7.3.3"));
          result.chainValid = chain.Build(certificate);
        }
        return result;
      } finally {
        // WTD_STATEACTION_CLOSE releases the provider state even after verification fails.
        data.stateAction = 2;
        try { WinVerifyTrust(new IntPtr(-1), ref action, ref data); }
        finally {
          Marshal.DestroyStructure(data.fileInfo, typeof(FileInfo));
          Marshal.FreeHGlobal(data.fileInfo);
        }
      }
    }
  }
}
'@
[LingAuthenticode]::Verify($env:LING_UPDATE_FILE) | ConvertTo-Json -Compress
`;

const signatureResultSchema = z.strictObject({
	path: z.string().min(1),
	trustStatus: z.number().int().nonnegative(),
	certificateSha256: z.string().nullable(),
	chainValid: z.boolean(),
});

/** Publisher names alone cannot distinguish two self-signed certificates with the same subject. */
export function validateWindowsSignature(result: unknown, file: string): string | null {
	const signature = signatureResultSchema.parse(result);
	if (win32.normalize(signature.path).toLowerCase() !== win32.normalize(file).toLowerCase())
		return "The signature result refers to a different update file";
	// Use the native trust result: PowerShell groups an untrusted root with unrelated failures.
	if (signature.trustStatus !== 0 && signature.trustStatus !== 0x800b0109)
		return `The update has an invalid Authenticode signature (0x${signature.trustStatus.toString(16)})`;
	if (signature.certificateSha256 !== signing.certificateSha256)
		return "The update is not signed by Ling's release certificate";
	// The pinned self-signed issuer has no revocation authority. Date, usage, signature and
	// explicit distrust checks still apply through the local certificate chain policy.
	if (!signature.chainValid) return "The release certificate failed validity or code-signing usage checks";
	return null;
}

export async function verifyWindowsUpdateSignature(
	publishers: string[],
	file: string,
	signal?: AbortSignal,
): Promise<string | null> {
	if (!publishers.includes(signing.publisher)) return "The update feed has an unexpected publisher";
	const systemRoot = process.env.SystemRoot;
	if (!systemRoot || !win32.isAbsolute(systemRoot)) throw new Error("Windows system directory is unavailable");
	const { stdout, stderr } = await execute(
		join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
		["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(VERIFY_SIGNATURE, "utf16le").toString("base64")],
		{
			...(signal ? { signal } : {}),
			windowsHide: true,
			// Certificate verification must not retain a native child indefinitely or unbounded output.
			timeout: 20_000,
			maxBuffer: 64 * 1024,
			env: { ...process.env, PSModulePath: "", LING_UPDATE_FILE: file },
		},
	);
	if (stderr.trim()) throw new Error(`Windows signature verification failed: ${stderr.trim()}`);
	return validateWindowsSignature(JSON.parse(stdout.trim()), file);
}
