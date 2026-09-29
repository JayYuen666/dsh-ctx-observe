// lib/usage-watch.ts —— 上下文压力判定 + 战略压缩建议时机（纯状态机）。
//
// 移植自 ECC suggest-compact（MIT）的判定思想并按 dsh 改写：
//   主信号 = 上下文 token 用量（dsh 的 assistant/message 事件 usage 字段），
//   辅信号 = 工具调用计数（弱代理：少数大读取可撑满窗口、多次小调用可跨计数）。
// ECC 注释原话：auto-compact 常在任务中段的任意点截断；战略压缩在
// 逻辑阶段边界保住上下文。本模块只回答"现在该不该提醒"。
//
// 触发语义（v5 起）：不同模型窗口不同（128k/200k/1M…），固定阈值是隐藏 bug 源。
// 默认改为窗口比例触发：setWindow(权威 contextWindow) 后，
//   阈值 = 窗口 × contextRatio（默认 70%），重复间隔 = 窗口 × remindRatio（默认 5%）。
// 显式绝对阈值（settings contextThresholdTokens）永远优先；窗口未知时回落 89_600
// （= 最小常见窗 128k × 0.7；旧固定 160k 会让 128k 模型永不触发，隐藏 bug）。

import { MESSAGES } from "./messages.ts";

export interface UsageWatchOptions {
  /** 建议正文：host 按官方 locale 偏好选好的文案。缺省 = 中文。 */
  remindText?: string;
  /** 显式绝对阈值（token 数）：设置后永远优先于窗口比例（用户显式配置优先）。默认无。 */
  contextThresholdTokens?: number;
  /** 窗口比例触发点：contextWindow × contextRatio 达到即首次提醒。默认 0.7（70%）。 */
  contextRatio?: number;
  /** 窗口比例重复间隔：contextWindow × remindRatio 再提醒。默认 0.05（5%）。 */
  remindRatio?: number;
  /** 无窗口信息（legacy 兜底）时的重复间隔。默认 60k。 */
  remindIntervalTokens?: number;
  /** tokens 未知时的辅信号：第 N 次工具调用首次提醒。默认 50。 */
  toolCountFirst?: number;
  /** 辅信号重复间隔。默认 25。 */
  toolCountInterval?: number;
  /** 两路窗口都取不到时假定的窗口（token）。默认 128_000；兜底阈值 = 假定窗 × contextRatio。 */
  fallbackWindow?: number;
}

/** 窗口比例默认（configSchema.contextRatio 的 .default() 引同一枚常量——单源）。 */
const DEFAULT_RATIO = 0.7;
const DEFAULT_REMIND_RATIO = 0.05;
// 窗口两路都取不到时的兜底阈值：假定最小常见窗口 128k × contextRatio(0.7) = 89_600。
// 旧固定 160k 会让 128k 窗口模型的压缩建议永不触发（用量封顶 ~128k < 160k）——隐藏 bug。
// 取偏保守（小窗）值：宁可早提醒不可漏提醒；间隔仍用较宽值避免大窗刷屏。
export const FALLBACK_WINDOW = 128_000;
/** 无窗口兜底重复间隔（configSchema.remindIntervalTokens 引同一枚常量）。 */
export const DEFAULT_INTERVAL = 60_000;
/** 辅信号首次提醒的工具调用数（configSchema.toolCountFirst 引同一枚常量）。 */
export const DEFAULT_TOOL_FIRST = 50;
/** 辅信号重复间隔（configSchema.toolCountInterval 引同一枚常量）。 */
export const DEFAULT_TOOL_INTERVAL = 25;

const REMIND_TEXT_DEFAULT = MESSAGES.zh.remindText;

/**
 * 一次提醒提案：text 是建议正文，commit 只在建议真的注入决策后调用。
 *
 * 为什么要把"判定"与"消费名额"拆开：agent/pre-step 是
 * Cordis waterfall，本插件注入的建议可能被下游监听器 {kind:'reject'} 丢掉。
 * 旧实现在判定当场就写 lastRemindAt，于是出现"模型没看到建议、名额却已花掉"
 * ——要再涨满一个 remindRatio 才会被再次提醒，最坏整段任务不再提醒。
 * 判定与提交分离后，未被注入的提案不留痕迹。
 */
export interface RemindProposal {
  /** 建议正文（注入为 user message 的 text 段）。 */
  readonly text: string;
  /** 提交提醒名额：置 lastRemindAt / lastRemindToolCount。幂等，可重复调用。 */
  commit: () => void;
}

export class UsageWatch {
  private readonly opts: Required<Omit<UsageWatchOptions, "contextThresholdTokens" | "remindText">>;
  /** 显式绝对阈值（settings 配置）；null = 未配置 → 窗口比例 → 固定默认。 */
  private explicitThreshold: number | null;
  /** 窗口未知时的兜底阈值 = 假定窗 × contextRatio（实例字段，随两枚旋钮走）。 */
  private readonly fallbackThreshold: number;
  /** 上次提醒时的 token 用量 */
  private lastRemindAt: number | null = null;
  private lastRemindToolCount: number | null = null;
  private lastSeenTokens: number | null = null;
  /** 权威上下文窗口（request/context 提供）。null = 未知 → 回落固定阈值。 */
  private windowTokens: number | null = null;
  /** 建议正文（host 每次取 watcher 时按 locale 同步；见 host 的 applySettingsToWatcher）。 */
  private remindText: string;

  public constructor(options: UsageWatchOptions = {}) {
    this.remindText = options.remindText ?? REMIND_TEXT_DEFAULT;
    this.explicitThreshold =
      options.contextThresholdTokens !== undefined && options.contextThresholdTokens > 0
        ? options.contextThresholdTokens
        : null;
    const { fallbackWindow } = options;
    this.opts = {
      contextRatio: options.contextRatio ?? DEFAULT_RATIO,
      remindRatio: options.remindRatio ?? DEFAULT_REMIND_RATIO,
      remindIntervalTokens: options.remindIntervalTokens ?? DEFAULT_INTERVAL,
      toolCountFirst: options.toolCountFirst ?? DEFAULT_TOOL_FIRST,
      toolCountInterval: options.toolCountInterval ?? DEFAULT_TOOL_INTERVAL,
      fallbackWindow:
        typeof fallbackWindow === "number" && Number.isFinite(fallbackWindow) && fallbackWindow > 0
          ? fallbackWindow
          : FALLBACK_WINDOW,
    };
    // 兜底阈值随假定窗与比例走（旧实现钉死 import 期常量，两枚旋钮都调不动它）。
    this.fallbackThreshold = Math.floor(this.opts.fallbackWindow * this.opts.contextRatio);
  }

  /**
   * 设定权威上下文窗口（token）。触发阈值改为 窗口×contextRatio（默认 70%），
   * 重复间隔改为 窗口×remindRatio（默认 5%）。显式绝对阈值永远优先于窗口比例。
   */
  public setWindow(windowTokens: number): void {
    if (Number.isFinite(windowTokens) && windowTokens > 0) {
      this.windowTokens = windowTokens;
    }
  }

  /** 换建议正文（语言切换用）；只影响之后的提案，不追溯已发出的消息。 */
  public setRemindText(text: string): void {
    this.remindText = text;
  }

  /** 当前生效阈值：显式绝对 > 窗口×ratio > 固定默认。 */
  private currentThreshold(): number {
    if (this.explicitThreshold !== null) {
      return this.explicitThreshold;
    }
    if (this.windowTokens !== null) {
      return Math.floor(this.windowTokens * this.opts.contextRatio);
    }
    return this.fallbackThreshold;
  }

  /** 当前生效重复间隔：窗口已知按窗口比例，否则固定间隔。 */
  private currentInterval(): number {
    if (this.windowTokens !== null) {
      return Math.floor(this.windowTokens * this.opts.remindRatio);
    }
    return this.opts.remindIntervalTokens;
  }

  /**
   * 观测一次，返回提醒提案或 undefined（本次不该提醒）。
   *
   * 只判定、不消费名额：调用方必须在建议真的注入决策后调用 `proposal.commit()`
   * （见 {@link RemindProposal}）。回落重武装与 lastSeenTokens 属"观测事实"，
   * 当场生效；提醒名额（lastRemindAt / lastRemindToolCount）只在 commit 时写。
   *
   * @param toolCount 本会话累计工具调用计数（单调增）。
   * @param contextTokens 最新一次请求的上下文占用量，host 侧按官方 pressure 口径
   *        计算 = inputTokens + cacheRead + cacheWrite（不含 output；仅当
   *        inputTokens 缺失时回退 totalTokens），缺失时辅信号兜底。
   */
  public observe(toolCount: number, contextTokens: number | undefined): RemindProposal | undefined {
    let proposal: RemindProposal | undefined;
    if (Number.isFinite(toolCount) && toolCount >= 0) {
      // 主信号：token 用量；辅信号（工具计数）仅在 tokens 未知时启用
      if (contextTokens !== undefined && Number.isFinite(contextTokens) && contextTokens >= 0) {
        proposal = this.proposeFromTokens(toolCount, contextTokens);
      } else if (toolCount >= this.opts.toolCountFirst) {
        proposal = this.proposeFromToolCount(toolCount);
      }
    }
    return proposal;
  }

  /** 主信号判定：tokens 达阈值且距上次提醒超过间隔 → 提案。 */
  private proposeFromTokens(toolCount: number, contextTokens: number): RemindProposal | undefined {
    const interval = this.currentInterval();
    // 回落检测：用量比上次提醒点低 interval 以上 → 视为已压缩，重新武装。
    // 该状态变更当场生效（不放 commit）：它是"释放名额"而非"消费名额"，
    // 且必须立刻释放，否则压缩后重新爬升到同一水位会被间隔判定吞掉。
    if (this.lastRemindAt !== null && contextTokens < this.lastRemindAt - interval) {
      this.lastRemindAt = null;
      this.lastRemindToolCount = null;
    }
    this.lastSeenTokens = contextTokens;
    let proposal: RemindProposal | undefined;
    if (contextTokens >= this.currentThreshold()) {
      const due = this.lastRemindAt === null || contextTokens - this.lastRemindAt >= interval;
      if (due) {
        proposal = {
          text: this.remindText,
          commit: (): void => {
            this.lastRemindAt = contextTokens;
            this.lastRemindToolCount = toolCount;
          },
        };
      }
    }
    return proposal;
  }

  /** 辅信号判定：tokens 未知时按工具计数间隔提案。 */
  private proposeFromToolCount(toolCount: number): RemindProposal | undefined {
    let proposal: RemindProposal | undefined;
    const due =
      this.lastRemindToolCount === null ||
      toolCount - this.lastRemindToolCount >= this.opts.toolCountInterval;
    if (due) {
      proposal = {
        text: this.remindText,
        commit: (): void => {
          this.lastRemindToolCount = toolCount;
        },
      };
    }
    return proposal;
  }

  /** 观测链专用：只记录最新 token 用量（不做任何提醒判定）。 */
  public noteTokens(tokens: number): void {
    if (Number.isFinite(tokens) && tokens >= 0) {
      this.lastSeenTokens = tokens;
    }
  }

  /** 最近一次观测到的 token 用量（metrics 端点用）。 */
  public lastTokens(): number | null {
    return this.lastSeenTokens;
  }

  /** 运行时校准阈值：写入显式绝对阈值（永远优先于窗口比例；host 用 settings 覆盖时调）。 */
  public setThreshold(thresholdTokens: number): void {
    if (Number.isFinite(thresholdTokens) && thresholdTokens > 0) {
      this.explicitThreshold = thresholdTokens;
    }
  }

  /**
   * 撤销显式绝对阈值，回到"窗口×比例"口径（host 在 settings 里清空
   * contextThresholdTokens 时必须调，见审计 item 6）。
   *
   * 只有 setThreshold 的话"清空设置"是假动作：setThreshold 对非法值不写，
   * 旧绝对阈值会一直压着窗口比例，直到会话销毁才恢复——用户已经把设置删了，
   * 判定却还按它走。
   */
  public clearThreshold(): void {
    this.explicitThreshold = null;
  }

  /**
   * 运行时改窗口比例（settings 编辑后已建 watcher 生效；host 的
   * applySettingsToWatcher 在每次 assistant/message 时调用）。
   * 范围：contextRatio ∈ (0, 1)，remindRatio ∈ (0, 1)；非法值忽略。
   */
  public setRatios(contextRatio?: number, remindRatio?: number): void {
    if (
      contextRatio !== undefined &&
      Number.isFinite(contextRatio) &&
      contextRatio > 0 &&
      contextRatio < 1
    ) {
      this.opts.contextRatio = contextRatio;
    }
    if (
      remindRatio !== undefined &&
      Number.isFinite(remindRatio) &&
      remindRatio > 0 &&
      remindRatio < 1
    ) {
      this.opts.remindRatio = remindRatio;
    }
  }

  /** 最近观测到的上下文窗口（metrics 用）。 */
  public window(): number | null {
    return this.windowTokens;
  }

  /** 清空状态（新会话）。窗口保留：窗口是会话属性，不随提醒周期重置。 */
  public reset(): void {
    this.lastRemindAt = null;
    this.lastRemindToolCount = null;
    this.lastSeenTokens = null;
  }
}
