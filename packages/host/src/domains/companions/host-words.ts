import type { UiLanguage } from "@ling/contracts/application";

export const TODO_REVIEW_PROMPT =
	"Please reconcile this conversation's todo list with the work already performed. Use the original todo tool to inspect the current list and update each verified completed task. Keep unfinished, blocked, failed, or cancelled work open and briefly explain what remains. Do not infer completion merely because the previous reply ended. Do not start unrelated work.";

const translations: Record<Exclude<UiLanguage, "en">, Readonly<Record<string, string>>> = {
	"zh-CN": {
		"Confirm schedule": "确认定时任务",
		Instructions: "任务内容",
		Repeat: "重复",
		"Time zone": "时区",
		Project: "项目",
		"Run in": "运行于",
		"This conversation": "继续原会话",
		"New conversation each time": "每次新建会话",
		Model: "模型",
		"Follow project model": "跟随项目模型",
		Reasoning: "思考",
		"Follow settings": "跟随设置",
		"Missed runs": "错过触发",
		"Skip missed runs": "跳过错过的任务",
		"Run latest once on return": "恢复后补跑最近一次",
		Notifications: "通知",
		"All runs": "所有运行",
		"Needs attention": "需要关注",
		None: "不通知",
		Once: "仅一次",
		"Every {{count}} minutes": "每 {{count}} 分钟",
		"Every day": "每天",
		Weekdays: "工作日",
		off: "关闭",
		minimal: "最低",
		low: "低",
		medium: "中",
		high: "高",
		xhigh: "极高",
		max: "最高",
		[TODO_REVIEW_PROMPT]:
			"请核对本会话的待办与实际完成的工作。使用原有 todo 工具读取清单，将有明确完成依据的条目更新为已完成；未完成、受阻、失败或已取消的工作保持未完成，并简要说明还缺什么。不要仅因上一条回答结束就认定任务完成，也不要开展无关工作。",
	},
	ja: {
		"Confirm schedule": "スケジュールを確認",
		Instructions: "手順",
		Repeat: "繰り返し",
		"Time zone": "タイムゾーン",
		Project: "プロジェクト",
		"Run in": "実行先",
		"This conversation": "この会話を続ける",
		"New conversation each time": "毎回新しい会話",
		Model: "モデル",
		"Follow project model": "プロジェクトのモデルを使用",
		Reasoning: "思考",
		"Follow settings": "設定に従う",
		"Missed runs": "実行できなかった場合",
		"Skip missed runs": "スキップ",
		"Run latest once on return": "復帰時に直近の 1 回を実行",
		Notifications: "通知",
		"All runs": "すべての実行",
		"Needs attention": "確認が必要な場合",
		None: "通知しない",
		Once: "1 回のみ",
		"Every {{count}} minutes": "{{count}} 分ごと",
		"Every day": "毎日",
		Weekdays: "平日",
		off: "オフ",
		minimal: "最小",
		low: "低",
		medium: "中",
		high: "高",
		xhigh: "非常に高い",
		max: "最大",
		[TODO_REVIEW_PROMPT]:
			"この会話のToDoを実際の作業結果と照合してください。元の todo ツールで一覧を確認し、完了の根拠がある項目だけ更新してください。未完了・中断・失敗・キャンセルした作業は未完了のままにして、残りを簡潔に説明してください。回答が終わっただけで完了とみなさず、無関係な作業は始めないでください。",
	},
	ko: {
		"Confirm schedule": "예약 작업 확인",
		Instructions: "지침",
		Repeat: "반복",
		"Time zone": "시간대",
		Project: "프로젝트",
		"Run in": "실행 위치",
		"This conversation": "이 대화에서 계속",
		"New conversation each time": "매번 새 대화",
		Model: "모델",
		"Follow project model": "프로젝트 모델 사용",
		Reasoning: "추론",
		"Follow settings": "설정 따르기",
		"Missed runs": "실행을 놓쳤을 때",
		"Skip missed runs": "건너뛰기",
		"Run latest once on return": "복귀 시 최근 1회 실행",
		Notifications: "알림",
		"All runs": "모든 실행",
		"Needs attention": "확인이 필요한 경우",
		None: "알리지 않음",
		Once: "한 번만",
		"Every {{count}} minutes": "{{count}}분마다",
		"Every day": "매일",
		Weekdays: "평일",
		off: "끄기",
		minimal: "최소",
		low: "낮음",
		medium: "중간",
		high: "높음",
		xhigh: "매우 높음",
		max: "최대",
		[TODO_REVIEW_PROMPT]:
			"이 대화의 할 일 목록을 실제 작업 결과와 대조하세요. 원래 todo 도구로 목록을 확인하고 완료 근거가 있는 항목만 갱신하세요. 미완료, 차단, 실패, 취소된 작업은 열린 상태로 두고 남은 일을 간단히 설명하세요. 응답이 끝났다는 이유만으로 완료 처리하거나 관련 없는 작업을 시작하지 마세요.",
	},
};

/** English keys double as the fallback text; used for agent-facing prompts and approval bodies. */
export function hostWords(language: UiLanguage | undefined) {
	const dictionary = language && language !== "en" ? translations[language] : undefined;
	return (text: string, values?: Record<string, string | number>): string => {
		const translated = dictionary?.[text] ?? text;
		return values
			? translated.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
					values[key] === undefined ? match : String(values[key]),
				)
			: translated;
	};
}
