// src/ui-messages.ts —— 设置卡 UI 文案字典（中英双语）。
//
// 键集一致由 tsc 保证：zh / en 两份都标注同一个 UiMessages 接口，少键多键在编译期红。
// 注册与取值走官方 @deepseek-ai/dsh-client-locale：`ctx.locale.register(ns, locale, dict)`
// + `ctx.locale.bind(ns)`，语言切换由宿主驱动、无需重载页面（见 client-entry.ts 的 apply）。
// 插值不放进字典（官方字典是扁平字符串表）：带变量的整行由调用点用固定模板 + 本表片段拼。
import type { TranslateNS as OfficialTranslateNS } from "@deepseek-ai/dsh-client-ui-slots";
import type { MessagesCatalog } from "@jayyuen66/dsh-plugin-shared/lib/locale";

/** 本包设置卡产出的全部界面文案。 */
export interface UiMessages {
  /** 卡片标题（设置页插件列表里的那一行）。 */
  readonly cardTitle: string;
  /** 卡片副标题：一句话说明本包做什么。 */
  readonly cardDescription: string;
  /** 作用域只读（非 loopback 页面）时的状态条文本。 */
  readonly statusReadOnly: string;
  /** 有未保存改动时的状态条文本。 */
  readonly statusDirty: string;
  /** 无未保存改动时的状态条文本。 */
  readonly statusClean: string;
  /** 保存按钮（空闲态）。 */
  readonly save: string;
  /** 保存按钮（写入中）。 */
  readonly saving: string;
  /** 撤销按钮。 */
  readonly revert: string;
  /** 窗口未知时的比例占位。 */
  readonly windowUnknown: string;
  /** metrics 首次加载中的占位。 */
  readonly metricsLoading: string;
  /** metrics 为空时的提示。 */
  readonly metricsEmpty: string;
  /** metrics 读取失败前缀（后接错误摘要）。 */
  readonly metricsLoadFailed: string;
  /** 保存失败前缀（后接错误摘要）。 */
  readonly saveFailed: string;
  /** 会话行里回合数后缀（拼在数字后；中文无前导空格、英文带）。 */
  readonly turnsSuffix: string;
  /** 会话行整行模板（官方 Translate 的 {name} 插值）。 */
  readonly sessionRow: string;
  /** metrics 汇总行整行模板。 */
  readonly metricsSummary: string;
  /** metrics 区块标题。 */
  readonly metricsHeading: string;
  readonly enabledLabel: string;
  readonly enabledHint: string;
  readonly suggestLabel: string;
  readonly suggestHint: string;
  readonly metricsLabel: string;
  readonly metricsHint: string;
  readonly thresholdLabel: string;
  readonly thresholdHint: string;
  readonly ratioLabel: string;
  readonly ratioHint: string;
  readonly remindRatioLabel: string;
  readonly remindRatioHint: string;
  readonly retentionLabel: string;
  readonly retentionHint: string;
  readonly remindIntervalLabel: string;
  readonly remindIntervalHint: string;
  readonly toolCountFirstLabel: string;
  readonly toolCountFirstHint: string;
  readonly toolCountIntervalLabel: string;
  readonly toolCountIntervalHint: string;
}

/**
 * 本包的文案命名空间 merge 进官方的 `LocaleNamespaceMap`（installed
 * `dsh-client-ui-slots/lib/types/index.d.ts:33`「Dictionary owners extend via declaration
 * merging (exactly like SlotMap)」）。这不是可选的美化：不 merge 时
 * `ctx.locale.bind(NS)` 只能落到官方那条**未类型化**重载，返回
 * `Translate<string>`，而卡片要的是键集收窄的 `t`，于是本地只好手写一个官方给不出的
 * 签名（写过的版本是 `bind: (ns: string) => Translate`，实测与
 * `LocaleRuntime['bind']` 冲突：`Type 'string' is not assignable to type 'keyof UiMessages'`）。
 * merge 之后键集由官方 `TranslateNS<NS>` 表达，`t("拼错的键")` 在编译期红，且
 * `LocaleRuntime['bind']` 的重载集可以原样用作 ctx 投影。
 * ⚠ 表键必须是字面量（interface 键位不接受计算属性），故下面的等式常量把它与
 * client-entry.ts 的 `NS` 钉在编译期：两边哪天分叉，这行就红。
 */
declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    /** 本包设置卡的全部界面文案键。 */
    "ctx-observe": keyof UiMessages;
  }
}

/** 本包命名空间的本源：merge 里写死的键、`Translate` 的键集、卡片条目 id 三处同串。 */
const LOCALE_NS_KEY = "ctx-observe" as const;

/**
 * 上面那枚串对外只以**类型**形态流通：`client-entry.ts` 的 `const NS: LocaleNs = "ctx-observe"`
 * 把条目 id 钉在本源上（分叉即编译期红），而产物漂移针仍要按字面量形状从 bundle 里抓 `NS`，
 * 所以那里保留字面量、只加类型标注——值导出不必存在。
 */
export type LocaleNs = typeof LOCALE_NS_KEY;

/**
 * 卡片取文案的函数形状：官方 `TranslateNS<N>`（installed `index.d.ts:67`
 * `= Translate<LocaleKeysOf<N>>`，而 `Translate<K> = (key: K, params?) => string`，
 * `index.d.ts:45`）——键集就是上面 merge 的 `keyof UiMessages`，函数面完全归官方。
 */
export type Translate = OfficialTranslateNS<typeof LOCALE_NS_KEY>;

export const UI_MESSAGES: MessagesCatalog<UiMessages> = {
  zh: {
    cardTitle: "ctx-observe 上下文观测",
    cardDescription:
      "上下文用量观测 + 战略压缩建议 + token metrics（ECC suggest-compact / cost-tracker 移植）",
    statusReadOnly: "当前作用域只读",
    statusDirty: "有未保存的修改，点「保存」生效",
    statusClean: "无未保存的修改",
    save: "保存",
    saving: "保存中…",
    revert: "撤销",
    windowUnknown: "窗口未知",
    metricsLoading: "metrics 读取中…",
    metricsEmpty: "暂无 metrics 记录",
    metricsLoadFailed: "metrics 读取失败：",
    saveFailed: "保存失败：",
    sessionRow: "{tokens} tok / {window}（{pct}）· {turns}{turnsSuffix}",
    metricsSummary: "共 {turns} 个回合观测 · {sessions} 个会话（每会话显示最新用量）",
    turnsSuffix: " 回合",
    metricsHeading: "上下文用量（实时 metrics）",
    enabledLabel: "启用观测",
    enabledHint: "关闭后不再观测 usage、不提醒压缩、不落 metrics",
    suggestLabel: "压缩建议",
    suggestHint: "用量达阈值时在阶段边界提醒做检查点压缩，避免 auto-compact 在任务中段任意截断",
    metricsLabel: "metrics 落盘",
    metricsHint:
      "每回合 token 流水按进程分片写入 dsh cache 目录 cache/ctx-observe/ctx-observe.<pid>.jsonl（可丢弃的派生数据，删了不丢事实）并暴露聚合端点",
    thresholdLabel: "显式绝对阈值（token）",
    thresholdHint: "配置后优先于窗口比例；留空 = 按窗口 × contextRatio 触发",
    ratioLabel: "窗口比例触发（contextRatio）",
    ratioHint: "contextWindow × ratio 达到即提醒（0.1-0.95，默认 0.7 = 70%）",
    remindRatioLabel: "窗口比例重复间隔（remindRatio）",
    remindRatioHint: "提醒后再增长窗口 × ratio 才重复（0.01-0.3，默认 0.05 = 5%）",
    retentionLabel: "分片留存天数（metricsRetentionDays）",
    retentionHint: "回收其它进程留下的过期 metrics/audit 分片；0 = 永久保留不回收（默认 30）",
    remindIntervalLabel: "无窗口重复间隔（remindIntervalTokens）",
    remindIntervalHint: "窗口未知时按固定 token 间隔重复提醒（默认 60000）",
    toolCountFirstLabel: "辅信号首提醒（toolCountFirst）",
    toolCountFirstHint: "用量拿不到时，第 N 次工具调用首次提醒（默认 50）",
    toolCountIntervalLabel: "辅信号重复间隔（toolCountInterval）",
    toolCountIntervalHint: "辅信号提醒后再增 N 次工具调用才重复（默认 25）",
  },
  en: {
    cardTitle: "ctx-observe context watch",
    cardDescription:
      "Context usage observation + strategic compaction suggestion + token metrics (ported from ECC suggest-compact / cost-tracker)",
    statusReadOnly: "This scope is read-only",
    statusDirty: "Unsaved changes — press Save to apply",
    statusClean: "No unsaved changes",
    save: "Save",
    saving: "Saving…",
    revert: "Revert",
    windowUnknown: "window unknown",
    metricsLoading: "loading metrics…",
    metricsEmpty: "no metrics recorded yet",
    metricsLoadFailed: "failed to load metrics: ",
    saveFailed: "save failed: ",
    sessionRow: "{tokens} tok / {window} ({pct}) · {turns}{turnsSuffix}",
    metricsSummary: "{turns} observed turns across {sessions} sessions (latest usage per session)",
    turnsSuffix: " turns",
    metricsHeading: "Context usage (live metrics)",
    enabledLabel: "Enable observation",
    enabledHint: "When off: no usage observation, no compaction suggestion, no metrics written",
    suggestLabel: "Compaction suggestion",
    suggestHint:
      "Once usage crosses the threshold, suggest a checkpoint at phase boundaries so auto-compact does not cut into the middle of a task",
    metricsLabel: "Persist metrics",
    metricsHint:
      "Per-turn token stream is sharded per process into the dsh cache directory cache/ctx-observe/ctx-observe.<pid>.jsonl (discardable derived data — deleting it loses no facts) and exposed through the aggregate endpoint",
    thresholdLabel: "Explicit absolute threshold (tokens)",
    thresholdHint: "Takes precedence over the window ratio; leave empty = window × contextRatio",
    ratioLabel: "Window ratio trigger (contextRatio)",
    ratioHint: "Remind once contextWindow × ratio is reached (0.1-0.95, default 0.7 = 70%)",
    remindRatioLabel: "Window ratio repeat interval (remindRatio)",
    remindRatioHint:
      "Repeat only after another window × ratio growth (0.01-0.3, default 0.05 = 5%)",
    retentionLabel: "Shard retention days (metricsRetentionDays)",
    retentionHint:
      "Sweep stale metrics/audit shards left by other processes; 0 = keep forever (default 30)",
    remindIntervalLabel: "No-window repeat interval (remindIntervalTokens)",
    remindIntervalHint:
      "When the window is unknown, re-remind on a fixed token interval (default 60000)",
    toolCountFirstLabel: "Auxiliary first remind (toolCountFirst)",
    toolCountFirstHint: "When usage is unavailable, first remind at the Nth tool call (default 50)",
    toolCountIntervalLabel: "Auxiliary repeat interval (toolCountInterval)",
    toolCountIntervalHint: "Re-remind after N more tool calls (default 25)",
  },
};
