import AntGroupColor from "@lobehub/icons-static-svg/icons/antgroup-color.svg?react";
import AzureColor from "@lobehub/icons-static-svg/icons/azure-color.svg?react";
import BasetenMono from "@lobehub/icons-static-svg/icons/baseten.svg?react";
import AmazonBedrockColor from "@lobehub/icons-static-svg/icons/bedrock-color.svg?react";
import CerebrasColor from "@lobehub/icons-static-svg/icons/cerebras-color.svg?react";
import ClaudeColor from "@lobehub/icons-static-svg/icons/claude-color.svg?react";
import CloudflareColor from "@lobehub/icons-static-svg/icons/cloudflare-color.svg?react";
import CursorMono from "@lobehub/icons-static-svg/icons/cursor.svg?react";
import DeepSeekColor from "@lobehub/icons-static-svg/icons/deepseek-color.svg?react";
import FireworksColor from "@lobehub/icons-static-svg/icons/fireworks-color.svg?react";
import GithubCopilotMono from "@lobehub/icons-static-svg/icons/githubcopilot.svg?react";
import GoogleColor from "@lobehub/icons-static-svg/icons/google-color.svg?react";
import GroqMono from "@lobehub/icons-static-svg/icons/groq.svg?react";
import HuggingFaceColor from "@lobehub/icons-static-svg/icons/huggingface-color.svg?react";
import KimiColor from "@lobehub/icons-static-svg/icons/kimi-color.svg?react";
import KimiMono from "@lobehub/icons-static-svg/icons/kimi.svg?react";
import MetaColor from "@lobehub/icons-static-svg/icons/meta-color.svg?react";
import MinimaxColor from "@lobehub/icons-static-svg/icons/minimax-color.svg?react";
import MistralColor from "@lobehub/icons-static-svg/icons/mistral-color.svg?react";
import MoonshotMono from "@lobehub/icons-static-svg/icons/moonshot.svg?react";
import NvidiaColor from "@lobehub/icons-static-svg/icons/nvidia-color.svg?react";
import OpenAIMono from "@lobehub/icons-static-svg/icons/openai.svg?react";
import OpenCodeMono from "@lobehub/icons-static-svg/icons/opencode.svg?react";
import OpenRouterColor from "@lobehub/icons-static-svg/icons/openrouter-color.svg?react";
import PiMono from "@lobehub/icons-static-svg/icons/pi.svg?react";
import QwenColor from "@lobehub/icons-static-svg/icons/qwen-color.svg?react";
import TogetherColor from "@lobehub/icons-static-svg/icons/together-color.svg?react";
import VercelMono from "@lobehub/icons-static-svg/icons/vercel.svg?react";
import VertexAIColor from "@lobehub/icons-static-svg/icons/vertexai-color.svg?react";
import XaiMono from "@lobehub/icons-static-svg/icons/xai.svg?react";
import XiaomiMono from "@lobehub/icons-static-svg/icons/xiaomimimo.svg?react";
import ZaiMono from "@lobehub/icons-static-svg/icons/zai.svg?react";
import { cn } from "@renderer/lib/utils";
import { Bot } from "lucide-react";
import type { ComponentProps } from "react";

/**
 * Kimi's Color mark is white on transparency, so on a light surface only its blue accent dot
 * survives. Mono follows currentColor there. The swap rides the `.dark` class on <html> rather
 * than a theme subscription, which would otherwise be one per rendered model row.
 */
function KimiGlyph({ className, ...props }: ComponentProps<typeof KimiColor>) {
	return (
		<>
			<KimiMono {...props} className={cn(className, "dark:hidden")} />
			<KimiColor {...props} className={cn(className, "hidden dark:inline")} />
		</>
	);
}

/** Command Code's official compact logomark, kept in its fixed black-and-white brand colors. */
function CommandCodeGlyph({ style, ...props }: ComponentProps<"svg">) {
	return (
		<svg
			fill="none"
			height="1em"
			style={{ flex: "none", lineHeight: 1, ...style }}
			viewBox="0 0 137 137"
			width="1em"
			xmlns="http://www.w3.org/2000/svg"
			{...props}
		>
			<path
				d="m0 66.7959c0-31.4879 0-47.2318 9.78204-57.01386 9.78206-9.78204 25.52596-9.78204 57.01396-9.78204h2.5357c31.4883 0 47.2323 0 57.0143 9.78204 9.782 9.78206 9.782 25.52596 9.782 57.01396v2.5357c0 31.4883 0 47.2323-9.782 57.0143s-25.526 9.782-57.0144 9.782h-2.5357c-31.4879 0-47.2318 0-57.01386-9.782-9.78204-9.782-9.78204-25.526-9.78204-57.0144z"
				fill="#000"
			/>
			<g fill="#fff">
				<path
					clipRule="evenodd"
					d="m69.3317 5.56633h-2.5357c-15.9014 0-27.2674.01182-35.905 1.17312-8.4775 1.13977-13.4886 3.29415-17.173 6.97855s-5.83878 8.6955-6.97855 17.173c-1.1613 8.6376-1.17312 20.0036-1.17312 35.9049v2.5357c0 15.9014.01182 27.2674 1.17312 35.9054 1.13977 8.477 3.29415 13.488 6.97855 17.173 3.6844 3.684 8.6955 5.838 17.173 6.978 8.6376 1.161 20.0036 1.173 35.9049 1.173h2.5357c15.9014 0 27.2674-.012 35.9054-1.173 8.477-1.14 13.488-3.294 17.173-6.978 3.684-3.685 5.838-8.696 6.978-17.173 1.161-8.638 1.173-20.004 1.173-35.9053v-2.5357c0-15.9014-.012-27.2674-1.173-35.905-1.14-8.4775-3.294-13.4886-6.978-17.173-3.685-3.6844-8.696-5.83878-17.173-6.97855-8.638-1.1613-20.004-1.17312-35.9053-1.17312zm-59.54966 4.21571c-9.78204 9.78206-9.78204 25.52596-9.78204 57.01386v2.5357c0 31.4884 0 47.2324 9.78204 57.0144 9.78206 9.782 25.52596 9.782 57.01386 9.782h2.5357c31.4884 0 47.2324 0 57.0144-9.782s9.782-25.526 9.782-57.0143v-2.5357c0-31.488 0-47.2319-9.782-57.01396-9.782-9.78204-25.526-9.78204-57.0143-9.78204h-2.5357c-31.488 0-47.2319 0-57.01396 9.78204z"
					fillRule="evenodd"
				/>
				<path d="m93.6604 26.1784c-8.982 0-16.2887 7.3067-16.2887 16.2888v6.9809h-18.6158v-6.9809c0-8.9821-7.3067-16.2888-16.2887-16.2888-8.9821 0-16.2888 7.3067-16.2888 16.2888s7.3067 16.2887 16.2888 16.2887h6.9809v18.6158h-6.9809c-8.9821 0-16.2888 7.3067-16.2888 16.2888 0 8.9825 7.3067 16.2885 16.2888 16.2885 8.982 0 16.2887-7.306 16.2887-16.2885v-6.981h18.6158v6.981c0 8.9825 7.3067 16.2885 16.2887 16.2885 8.9826 0 16.2886-7.306 16.2886-16.2885 0-8.9821-7.306-16.2888-16.2886-16.2888h-6.9809v-18.6158h6.9809c8.9826 0 16.2886-7.3066 16.2886-16.2887s-7.306-16.2888-16.2886-16.2888zm-6.9809 23.2697v-6.9809c0-3.8628 3.1182-6.9809 6.9809-6.9809 3.8628 0 6.9806 3.1181 6.9806 6.9809 0 3.8627-3.1178 6.9809-6.9806 6.9809zm-44.2123 0c-3.8628 0-6.9809-3.1182-6.9809-6.9809 0-3.8628 3.1181-6.9809 6.9809-6.9809 3.8627 0 6.9809 3.1181 6.9809 6.9809v6.9809zm16.2887 27.9236v-18.6158h18.6158v18.6158zm34.9045 23.2693c-3.8627 0-6.9809-3.1178-6.9809-6.9805v-6.981h6.9809c3.8628 0 6.9806 3.1182 6.9806 6.981 0 3.8627-3.1178 6.9805-6.9806 6.9805zm-51.1932 0c-3.8628 0-6.9809-3.1178-6.9809-6.9805 0-3.8628 3.1181-6.981 6.9809-6.981h6.9809v6.981c0 3.8627-3.1182 6.9805-6.9809 6.9805z" />
			</g>
		</svg>
	);
}

/**
 * Brand glyph component table: canonical identity → icon component (not Pi provider id).
 * Prefer Lobehub's original-color variant. Use an official inline mark only when the catalog has
 * no matching brand, and use Mono for identities designed to adapt to currentColor.
 */
const PROVIDER_GLYPHS = {
	"amazon-bedrock": AmazonBedrockColor,
	anthropic: ClaudeColor,
	"ant-group": AntGroupColor,
	azure: AzureColor,
	baseten: BasetenMono,
	cerebras: CerebrasColor,
	cloudflare: CloudflareColor,
	commandcode: CommandCodeGlyph,
	cursor: CursorMono,
	deepseek: DeepSeekColor,
	fireworks: FireworksColor,
	"github-copilot": GithubCopilotMono,
	google: GoogleColor,
	groq: GroqMono,
	huggingface: HuggingFaceColor,
	kimi: KimiGlyph,
	meta: MetaColor,
	minimax: MinimaxColor,
	mistral: MistralColor,
	moonshot: MoonshotMono,
	nvidia: NvidiaColor,
	openai: OpenAIMono,
	opencode: OpenCodeMono,
	openrouter: OpenRouterColor,
	radius: PiMono,
	qwen: QwenColor,
	together: TogetherColor,
	vercel: VercelMono,
	"vertex-ai": VertexAIColor,
	xai: XaiMono,
	xiaomi: XiaomiMono,
	zai: ZaiMono,
} as const;

type ProviderGlyphName = keyof typeof PROVIDER_GLYPHS;

/**
 * Pi built-in provider id → brand glyph. Multiple ids may share one brand (e.g. openai / openai-codex);
 * unknown ids fall back to the neutral Bot icon.
 */
const PROVIDER_GLYPH_BY_ID: Readonly<Record<string, ProviderGlyphName>> = {
	"amazon-bedrock": "amazon-bedrock",
	"ant-ling": "ant-group",
	anthropic: "anthropic",
	"azure-openai-responses": "azure",
	baseten: "baseten",
	cerebras: "cerebras",
	"cloudflare-ai-gateway": "cloudflare",
	"cloudflare-workers-ai": "cloudflare",
	commandcode: "commandcode",
	cursor: "cursor",
	deepseek: "deepseek",
	fireworks: "fireworks",
	"github-copilot": "github-copilot",
	google: "google",
	"google-vertex": "vertex-ai",
	groq: "groq",
	huggingface: "huggingface",
	"kimi-coding": "kimi",
	meta: "meta",
	minimax: "minimax",
	"minimax-cn": "minimax",
	mistral: "mistral",
	moonshotai: "moonshot",
	"moonshotai-cn": "moonshot",
	nvidia: "nvidia",
	openai: "openai",
	"openai-codex": "openai",
	opencode: "opencode",
	"opencode-go": "opencode",
	openrouter: "openrouter",
	radius: "radius",
	"qwen-token-plan": "qwen",
	"qwen-token-plan-cn": "qwen",
	"qwen-token-plan-individual": "qwen",
	together: "together",
	"vercel-ai-gateway": "vercel",
	xai: "xai",
	xiaomi: "xiaomi",
	"xiaomi-token-plan-ams": "xiaomi",
	"xiaomi-token-plan-cn": "xiaomi",
	"xiaomi-token-plan-sgp": "xiaomi",
	zai: "zai",
	"zai-coding-cn": "zai",
};

/** Pure provider-id lookup. Null means the caller should render the neutral fallback. */
function providerGlyphName(providerId: string): ProviderGlyphName | null {
	if (!Object.hasOwn(PROVIDER_GLYPH_BY_ID, providerId)) return null;
	return PROVIDER_GLYPH_BY_ID[providerId] ?? null;
}

export function ProviderGlyph({ provider, size, className }: { provider: string; size: number; className?: string }) {
	const glyphName = providerGlyphName(provider);
	if (glyphName === null) {
		return <Bot aria-hidden="true" className={className} size={size} strokeWidth={1.75} />;
	}
	const Glyph = PROVIDER_GLYPHS[glyphName];
	return <Glyph aria-hidden="true" className={className} focusable="false" width={size} height={size} />;
}
