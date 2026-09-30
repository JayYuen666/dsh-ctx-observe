// ctx-observe client 半：设置卡（开关 + 数字字段）。
// 参照 zvec-grep / session-rescue 的卡片模式：keyed plugins.bundle.config 槽，
// React 由模块系统提供（rolldown external），只用 createElement。

import { createElement, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { BuiltInLocaleId } from "@deepseek-ai/dsh-client-locale/client";
import type { LocaleDictOf } from "@deepseek-ai/dsh-client-ui-slots";
import type { SlotRegistry } from "@deepseek-ai/dsh-client-ui-renderer/client";
import type { ConfigForm, ConfigFormSnapshot } from "@deepseek-ai/dsh-client-ui-settings/client";
// 槽位契约的所有权在属主包：`plugins.bundle.config` 由 plugin-manager 通过
// `declare module '@deepseek-ai/dsh-client-ui-slots' { interface SlotMap }` 交出
// （installed `dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:78-84`，
// 文件头明写「A registrant merges this contract with `import type` and registers
// through `ctx.slots`; it never imports this package at runtime」）。原来本包自己手抄过
// 一份同形状的 merge，那份抄写已删除：抄一次就多一处漂移点，而属主的 dts 现在是本包
// devDependency，编译器可以替我们对表。
// 这里取 `ConfigPageForm` 是**一举两得**：既是把那份 merge 载入 program 的入口（TS 会
// 顺着 `./client` 的再导出走到 slot-contract.ts），也是本卡渲染视模型两个状态位的真源
// （见下面 CardSnapshot）。lint 的 `require-module-specifiers` 禁空 import specifier，
// 正合本意——载入官方契约就该同时*用上*它。
import type { ConfigPageForm } from "@deepseek-ai/dsh-client-ui-plugin-manager/client";
import { UI_MESSAGES } from "./ui-messages.ts";
import type { LocaleNs, Translate, UiMessages } from "./ui-messages.ts";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

const NS: LocaleNs = "ctx-observe";

// ⚠ 两个**不同**的标识，别混用（混用过的形状：卡片打不开 / 保存写进别的条目）：
//  - `NS` = loader 条目 id = settings 命名空间 = `configForms.get(NS)` 的入参，
//    真源是本包 cordis.patch.yml 的裸 `- id:`（宿主读 `entry.options.id`）；字面量按
//    `LocaleNs` 标注钉在 src/ui-messages.ts 那枚本源上，分叉即编译期红。
//  - 下面这个常量 = 本包在 profile 里那条 bundle 的**包名**，只当槽位 key 用。
// `plugins.bundle.config` 是按 bundle 包名 keyed 的槽位：宿主把注册项的 key 与
// bundle 包名精确相等匹配后才渲染（installed
// dsh-client-ui-plugin-manager/lib/client.js:1821 的
// `renderSlot("plugins.bundle.config", { view: "page" }, { entryKey: pkg.name })` →
// dsh-client-ui-renderer/lib/client.js:1154 的 `e.options.key === opts?.entryKey`；
// 同文件 :2698 的 `configured: ledger.bundles.has(openPkg.name)` 读的就是这批 key），
// 契约文本 installed dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:96-100
// （"keyed by the bundle's package name"），首方先例
// dsh-experimental-client-ui-voice-input/lib/client.js:5659-5661。
// 写成裸条目 id（`ctx-observe`）时 ledger 里没有这个键 → 插件页永不出卡。
// 包名真源：`~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles`；
// test/profile-bundle.ts 把真源读进测试，test/build-client.test.ts 的漂移针据此钉。
const BUNDLE_PKG = "@jayyuen66/dsh-ctx-observe";

// `plugins.bundle.config` 的类型契约现在来自属主包（文件头那条 `import type {}`），
// 于是 `ctx.slots.inject/register` 的槽位名是**编译期受检**的（拼错 key 直接红，见下面
// ClientCtx.slots）。本卡只渲染 `view: 'page'`，`form` 位不消费（写入走自己的
// `configForms.get(NS)`，见 apply）。

// SVG <path> 的短属性键 `d`：直接写触发 id-length，加引号又会被 oxfmt 去引号，
// 用计算键变量承载（≥2 字符标识符）——两规则均不触发（zvec-grep 同款做法）。
const PATH_KEY = "d";

const CARD_CSS = [
  ".coc-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}",
  ".coc-card:hover{border-color:var(--dsw-alias-label-dimmed)}",
  ".coc-card-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}",
  ".coc-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:transparent;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}",
  ".coc-head{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}",
  ".coc-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}",
  ".coc-desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}",
  ".coc-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}",
  ".coc-chevron-open{transform:rotate(180deg)}",
  ".coc-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding:8px 0 12px}",
  ".coc-row{display:flex;flex-direction:row;justify-content:space-between;align-items:center;gap:12px;padding:9px 0}",
  ".coc-label{font-size:13px;color:var(--dsw-alias-label-primary,inherit)}",
  ".coc-hint{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8f99);line-height:1.5;margin-top:2px}",
  ".coc-switch{appearance:none;position:relative;width:34px;height:20px;border-radius:10px;background:var(--dsw-alias-fill-primary,#d8dbe2);transition:background .16s;cursor:pointer;border:0;flex:none}",
  '.coc-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-layer-1,#fff);transition:left .16s}',
  ".coc-switch-on{background:var(--dsw-alias-brand-primary,#e07856)}",
  ".coc-switch-on::after{left:16px}",
  ".coc-switch:disabled{cursor:not-allowed;opacity:.6}",
  ".coc-input{width:100%;box-sizing:border-box;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid var(--dsw-alias-border-l2,transparent);border-radius:8px;padding:6px 8px;margin-top:4px}",
  // 保存条（改动先暂存，点「保存」才写入生效；「撤销」丢弃本地改动）
  ".coc-savebar{display:flex;gap:8px;align-items:center;padding:10px 0 2px;border-top:1px dashed var(--dsw-alias-border-l2);margin-top:6px;flex-wrap:wrap}",
  ".coc-btn{appearance:none;font:inherit;font-size:12px;cursor:pointer;border-radius:6px;padding:4px 12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit)}",
  ".coc-btn:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed)}",
  ".coc-btn-primary{background:var(--dsw-alias-brand-primary,#e07856);border-color:var(--dsw-alias-brand-primary,#e07856);color:var(--dsw-alias-label-primary-foreground,#fff)}",
  ".coc-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#e07856);outline-offset:1px}",
  ".coc-btn:disabled{opacity:.5;cursor:not-allowed}",
  ".coc-dirty{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8f99)}",
  ".coc-saveerr{font-size:12px;color:#c4483f}",
].join("\n");

/** 客户端配置面直接取官方声明：`@deepseek-ai/dsh-client-ui-settings/client` 交出的
 *  `ConfigForm<T>`（getSnapshot / subscribe / set / unset）与 `ConfigForms` 服务
 *  （`dsh-client-ui-settings` 已把 `configForms` 增强进 cordis `Context`）。
 *  原先这里手抄了一份 `getSnapshot: () => unknown`，快照字段全靠 fieldOf 逐位再解析一遍
 *  ——那个解析器只是丢失类型的补救，不是宿主契约（宿主侧 ConfigForms 会 decode/derive）。
 *  ⚠ 官方 `configForms.get(entryId)` 返回的表单**没有 dispose()**（表单归 provider 持有），
 *  且 `set`/`unset` 多了受理位：true=宿主受理，false=拒绝或被跳过，只有传输失败才 reject。
 *  本卡失败面仍以 Promise 拒绝为准，受理位 await 后即弃（这轮只换入口，不改行为）。 */
export type EntryForm = ConfigForm<Record<string, unknown>>;

/**
 * 官方 `LocaleRuntime.register` 类型化重载的字典参数，取在本包命名空间上：
 * `Record<BuiltInLocaleId, LocaleDictOf<'ctx-observe'>>`——两语（官方 `BuiltInLocaleId`）
 * 必须齐、每语的键集必须等于 `UiMessages`，都由官方表达式给出。
 */
export type LocaleCatalog = Record<BuiltInLocaleId, LocaleDictOf<typeof NS>>;

/** 本卡自己的渲染视模型（官方快照的有用子集 + 兜底值）。
 *  `status`/`writable` 两位不再手写联合：它们取自属主包交给配置页的那份官方状态
 *  （`ConfigPageForm['state']`，installed `dsh-client-ui-plugin-manager/lib/types/client/
 *  slot-contract.d.ts:150-155`，其类型就是官方 `ConfigFormSnapshot<Record<string, unknown>>`
 *  的再投影）。宿主把 status 的取值域或 writable 的必选性一改，这里当场红。
 *  两者都满足才允许写，故保持**必选**，不用可选位假装它们会缺；`value` 是本卡的兜底
 *  收窄（官方 `value: T | undefined` → 首个快照受理前落成空对象供渲染）。 */
export interface CardSnapshot extends Pick<ConfigPageForm["state"], "status" | "writable"> {
  value: Record<string, unknown>;
}

interface ToggleRowProps {
  label: string;
  hint: string;
  /** 稳定锚点（schema-coverage 门禁按此识别绑定字段）。 */
  field: string;
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
}

function ToggleRow(props: ToggleRowProps): ReactNode {
  return createElement(
    "div",
    { className: "coc-row" },
    createElement(
      "div",
      null,
      createElement("div", { className: "coc-label" }, props.label),
      createElement("div", { className: "coc-hint" }, props.hint),
    ),
    createElement("button", {
      type: "button",
      className: `coc-switch${props.checked ? " coc-switch-on" : ""}`,
      role: "switch",
      "aria-checked": props.checked,
      "data-field": props.field,
      disabled: props.disabled === true,
      onClick: props.onToggle,
    }),
  );
}

export interface NumberInputRowProps {
  label: string;
  hint: string;
  field: string;
  value: unknown;
  onChange: (field: string, value: unknown) => void;
  /** 清空输入 → 清回组装层（scope.unset）。 */
  onEmpty: (field: string) => void;
  disabled?: boolean;
  min?: number;
  max?: number;
}

/** 数字输入行：settings 数字字段 ↔ UI 字符串（v7 配置面补齐）。 */
function NumberInputRow(props: NumberInputRowProps): ReactNode {
  const num =
    typeof props.value === "number" && Number.isFinite(props.value) ? String(props.value) : "";
  const [text, setText] = useState(num);
  // A8：外部快照变化（别处改了设置）→ 回写输入框，避免陈旧显示。
  useEffect(() => {
    setText(num);
  }, [num]);
  return createElement(
    "div",
    { className: "coc-row" },
    createElement(
      "div",
      null,
      createElement("div", { className: "coc-label" }, props.label),
      createElement("div", { className: "coc-hint" }, props.hint),
      createElement("input", {
        type: "number",
        className: "coc-input",
        value: text,
        disabled: props.disabled === true,
        onChange: (ev: { target: { value: string } }) => {
          const next = ev.target.value;
          setText(next);
          // A8：清空 = 清回组装层（显式阈值留空 → 窗口比例生效），不再静默丢弃。
          if (next === "") {
            props.onEmpty(props.field);
            return;
          }
          const parsed = Number(next);
          if (!Number.isFinite(parsed)) {
            return;
          }
          const min = props.min ?? -Infinity;
          const max = props.max ?? Infinity;
          if (parsed >= min && parsed <= max) {
            props.onChange(props.field, parsed);
          }
        },
      }),
    ),
  );
}

export interface DgCardProps {
  /** 取文案（官方 ctx.locale.bind 的结果，见 apply）。 */
  t: Translate;
  /**
   * 框架把 slots.register 注入的 `hooks.card` 绑成 uSES selector Hook。返回位带
   * `| undefined`：官方同一形状在「源可缺席」那一档就是
   * `MaybeSnapshotSelectorHook<T> = <S>(sel) => S | undefined`（installed
   * `dsh-client-store/lib/types/contract.d.ts:25`，其文档原话 "the hook is always
   * present, while its selected value is absent whenever no session is current"），
   * 而不是非空的 `SnapshotSelectorHook`（同文件 :18）。缺席时卡片按默认值渲染，
   * 这一态由 test/client-card.test.ts 的「snap 为 undefined → value 兜底 {}」钉住
   * （桩件 `(() => { void 0; }) as never`），所以下面 DgCard 的 `snap?.` 与 `?? {}`
   * 是活守卫，不是可以删的冗余。
   */
  useCard: <TValue>(selector: (snap: CardSnapshot) => TValue) => TValue | undefined;
  set: (field: string, value: unknown) => Promise<void>;
  unset: (field: string) => Promise<void>;
  /** 测试展开卡片用；生产调用不传（默认折叠）。 */
  initialOpen?: boolean;
}

// ── 保存条模式（全自研插件统一）──────────────────────────────────────────
// touched-overlay：只记录用户动过的字段，控件渲染 = touched 优先、快照兜底。
// 点「保存」只写差异字段（touched 值为 undefined → unset 恢复默认）；「撤销」清空
// touched。未触碰字段跟随外部快照，不存在草稿/快照键位漂移问题。

/** touched 层与快照的差异字段（值语义比较；undefined 与缺失等价）。 */
export function diffTouched(
  touched: Record<string, unknown>,
  value: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  for (const key of Object.keys(touched)) {
    if (JSON.stringify(touched[key] ?? null) !== JSON.stringify(value[key] ?? null)) {
      out.push(key);
    }
  }
  return out;
}

export interface SaveBarProps {
  dirty: boolean;
  writable: boolean;
  busy: boolean;
  error: string | null;
  t: Translate;
  onSave: () => void;
  onDiscard: () => void;
}

function SaveBar(props: SaveBarProps): ReactNode {
  const dis = !props.writable || props.busy;
  let statusText: string;
  if (!props.writable) {
    statusText = props.t("statusReadOnly");
  } else if (props.dirty) {
    statusText = props.t("statusDirty");
  } else {
    statusText = props.t("statusClean");
  }
  return createElement(
    "div",
    { className: "coc-savebar" },
    createElement(
      "button",
      {
        type: "button",
        className: "coc-btn coc-btn-primary",
        "data-field": "save",
        disabled: dis || !props.dirty,
        onClick: props.onSave,
      },
      props.busy ? props.t("saving") : props.t("save"),
    ),
    createElement(
      "button",
      {
        type: "button",
        className: "coc-btn",
        "data-field": "discard",
        disabled: dis || !props.dirty,
        onClick: props.onDiscard,
      },
      props.t("revert"),
    ),
    props.error === null
      ? createElement("span", { className: "coc-dirty" }, statusText)
      : createElement("span", { className: "coc-saveerr" }, props.error),
  );
}

// ── metrics 消费区（卡片消费自己的端点，不再只有开关没数据）──────────────

export interface MetricRow {
  ts?: number;
  session?: string;
  turn?: number;
  tokens?: number;
  contextWindow?: number;
}

export interface SessionSummary {
  session: string;
  tokens: number;
  contextWindow: number | null;
  ratio: number | null;
  turns: number;
  lastTs: number;
}

/** 用量比例：窗口缺失或非正数时不可知（null 交回 UI 的「窗口未知」占位）。 */
const usageRatioOf = (tokens: number, contextWindow: number | null): number | null =>
  contextWindow !== null && contextWindow > 0 ? tokens / contextWindow : null;

/** 一行 JSONL 投影出的聚合事实（坏字段按 0 / null 静默降级，与旧内联写法逐字同口径）。 */
interface RowFacts {
  /** 会话键：缺 session 字段或空串都落到 "default"。 */
  sid: string;
  tokens: number;
  contextWindow: number | null;
  ts: number;
}

/** 把单行 metrics 投影成聚合事实——四字段的存在性判定集中在这一个纯函数里。 */
function rowFactsOf(row: MetricRow): RowFacts {
  return {
    sid: typeof row.session === "string" && row.session.length > 0 ? row.session : "default",
    tokens: typeof row.tokens === "number" ? row.tokens : 0,
    contextWindow:
      typeof row.contextWindow === "number" && row.contextWindow > 0 ? row.contextWindow : null,
    ts: typeof row.ts === "number" ? row.ts : 0,
  };
}

/** 已见过的会话：取时间戳最新的行为该会话的当前用量，更早的行只累加回合数。 */
function foldIntoSummary(prev: SessionSummary, facts: RowFacts): void {
  if (facts.ts >= prev.lastTs) {
    prev.tokens = facts.tokens;
    prev.contextWindow = facts.contextWindow;
    prev.ratio = usageRatioOf(facts.tokens, facts.contextWindow);
    prev.lastTs = facts.ts;
  }
  prev.turns += 1;
}

/** 首见会话的摘要初值：turns 从 1 起算，ratio 与后续折叠同一口径。 */
function summaryOf(facts: RowFacts): SessionSummary {
  return {
    session: facts.sid,
    tokens: facts.tokens,
    contextWindow: facts.contextWindow,
    ratio: usageRatioOf(facts.tokens, facts.contextWindow),
    turns: 1,
    lastTs: facts.ts,
  };
}

/** 把 JSONL 行聚合成 per-session 最新用量摘要（native pressure 口径已由 host 算好）。 */
export function summarizeMetrics(rows: MetricRow[]): { sessions: SessionSummary[]; total: number } {
  const bySession = new Map<string, SessionSummary>();
  for (const row of rows) {
    const facts = rowFactsOf(row);
    const prev = bySession.get(facts.sid);
    if (prev === undefined) {
      bySession.set(facts.sid, summaryOf(facts));
    } else {
      foldIntoSummary(prev, facts);
    }
  }
  // 排序取时间戳最新在前的高用水会话。用 `.toSorted` 而不是 `.sort`：后者原地改数组，
  // 会被 unicorn/no-array-sort 判死。client 基线的 target/lib 与官方对齐到 ES2024 之后
  // 这条 API 在 tsc 与 oxlint 的类型引擎里都认（早先 tsgolint 回落旧 lib 时报 TS2550，
  // 当时的绕行是原地 sort + 行内豁免，现在不需要了）。
  const sessions = [...bySession.values()].toSorted((left, right) => right.lastTs - left.lastTs);
  return { sessions, total: rows.length };
}

/** 从未知 JSON 行投影为 MetricRow（字段类型不符 → 该字段缺失，坏行静默降级）。 */
function metricRowOf(raw: unknown): MetricRow {
  if (!isRecord(raw)) {
    return {};
  }
  const { ts, session: sessionV, turn, tokens, contextWindow } = raw;
  const row: MetricRow = {};
  if (typeof ts === "number") {
    row.ts = ts;
  }
  if (typeof sessionV === "string") {
    row.session = sessionV;
  }
  if (typeof turn === "number") {
    row.turn = turn;
  }
  if (typeof tokens === "number") {
    row.tokens = tokens;
  }
  if (typeof contextWindow === "number") {
    row.contextWindow = contextWindow;
  }
  return row;
}

const fmtPct = (t: Translate, ratio: number | null): string =>
  ratio === null ? t("windowUnknown") : `${(ratio * 100).toFixed(1)}%`;

/**
 * 会话行的用量文本（官方 locale 的 {name} 插值）。提成模块级函数是为了不把 t()
 * 嵌进四层 createElement（unicorn/max-nested-calls 上限 3）。
 */
function sessionRowText(t: Translate, sess: SessionSummary): string {
  return t("sessionRow", {
    tokens: sess.tokens.toLocaleString(),
    window: sess.contextWindow === null ? "?" : sess.contextWindow.toLocaleString(),
    pct: fmtPct(t, sess.ratio),
    turns: sess.turns,
    turnsSuffix: t("turnsSuffix"),
  });
}

function MetricsSection(props: { t: Translate }): ReactNode {
  const { t } = props;
  const [state, setState] = useState<{
    loading: boolean;
    error: string | null;
    summary: { sessions: SessionSummary[]; total: number } | null;
  }>({ loading: true, error: null, summary: null });
  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const res = await fetch("/_dsh/ctx-observe/metrics", { headers: { accept: "text/plain" } });
        // F1 之后 403 也回 JSON 体（`{"ok":false,"error":"…"}`），而下面按行 JSON.parse——
        // 不先看状态码就会把那句拒绝当成"一行用量数据"渲出来（1 turn / 1 session 的幽灵卡）。
        if (!res.ok) {
          throw new Error(`metrics endpoint returned ${String(res.status)}`);
        }
        const text = await res.text();
        const rows: MetricRow[] = [];
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (trimmed.length > 0) {
            // 坏行跳过（JSON.parse 抛错由 catch 承接）
            try {
              const parsed: unknown = JSON.parse(trimmed);
              rows.push(metricRowOf(parsed));
            } catch {
              // ignore malformed line
            }
          }
        }
        if (alive) {
          setState({ loading: false, error: null, summary: summarizeMetrics(rows) });
        }
      } catch (error: unknown) {
        if (alive) {
          setState({
            loading: false,
            error: String(error instanceof Error ? error.message : error),
            summary: null,
          });
        }
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, []);
  if (state.loading) {
    return createElement(
      "div",
      { className: "coc-hint", style: { padding: "6px 0" } },
      t("metricsLoading"),
    );
  }
  if (state.error !== null) {
    return createElement(
      "div",
      { className: "coc-hint", style: { padding: "6px 0", color: "#c4483f" } },
      `${t("metricsLoadFailed")}${state.error}`,
    );
  }
  const { summary } = state;
  if (summary === null || summary.total === 0) {
    return createElement(
      "div",
      { className: "coc-hint", style: { padding: "6px 0" } },
      t("metricsEmpty"),
    );
  }
  return createElement(
    "div",
    null,
    createElement(
      "div",
      { className: "coc-hint", style: { padding: "4px 0" } },
      t("metricsSummary", { turns: summary.total, sessions: summary.sessions.length }),
    ),
    createElement(
      "ul",
      { style: { listStyle: "none", margin: "0", padding: "0" } },
      summary.sessions.map((sess) =>
        createElement(
          "li",
          {
            key: sess.session,
            style: {
              display: "flex",
              justifyContent: "space-between",
              gap: "12px",
              padding: "5px 0",
              borderBottom: "1px solid var(--dsw-alias-border-l2)",
            },
          },
          createElement("span", { className: "coc-label" }, sess.session),
          createElement("span", { className: "coc-hint" }, sessionRowText(t, sess)),
        ),
      ),
    ),
  );
}

/** 折叠头的渲染入参（两行文案已在调用点取成字符串，见 DgCard 的那条注释）。 */
interface CardHeaderArgs {
  title: string;
  description: string;
  open: boolean;
  onToggle: () => void;
}

/** 卡片头部：标题两行 + chevron，折叠态唯一可见的那一块。 */
function buildCardHeader(args: CardHeaderArgs): ReactNode {
  const { title, description, open, onToggle } = args;
  return createElement(
    "button",
    {
      type: "button",
      className: "coc-header",
      "aria-expanded": open,
      onClick: onToggle,
    },
    createElement(
      "div",
      { className: "coc-head" },
      createElement("div", { className: "coc-name" }, title),
      createElement("div", { className: "coc-desc" }, description),
    ),
    createElement(
      "svg",
      {
        width: 14,
        height: 14,
        viewBox: "0 0 14 14",
        "aria-hidden": true,
        className: `coc-chevron${open ? " coc-chevron-open" : ""}`,
      },
      // SVG path 属性键用变量承载：短键 `d` 直接写会触发 id-length，
      // 引号形式（"d"）又被 oxfmt 去引号——变量计算键 [PATH_KEY] 两规则都不触发。
      createElement("path", {
        [PATH_KEY]: "M3 5l4 4 4-4",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.5,
        strokeLinecap: "round",
        strokeLinejoin: "round",
      }),
    ),
  );
}

/** 设置行共用的渲染上下文：取值口径 + 可写位 + 两个写草稿的口（草稿态仍在 DgCard）。 */
interface RowCtx {
  t: Translate;
  eff: (field: string) => unknown;
  writable: boolean;
  setField: (field: string, val: unknown) => void;
  clearField: (field: string) => void;
}

/** 一行的字段名与两行文案键：field 就是写进 settings 的键（schema 同源）。 */
interface ToggleFieldSpec {
  field: string;
  label: keyof UiMessages;
  hint: keyof UiMessages;
}

const ENABLED_FIELD: ToggleFieldSpec = {
  field: "enabled",
  label: "enabledLabel",
  hint: "enabledHint",
};
const SUGGEST_FIELD: ToggleFieldSpec = {
  field: "suggestEnabled",
  label: "suggestLabel",
  hint: "suggestHint",
};
const METRICS_PERSIST_FIELD: ToggleFieldSpec = {
  field: "metricsEnabled",
  label: "metricsLabel",
  hint: "metricsHint",
};

function buildToggleRow(ctx: RowCtx, spec: ToggleFieldSpec): ReactNode {
  return createElement(ToggleRow, {
    field: spec.field,
    label: ctx.t(spec.label),
    hint: ctx.t(spec.hint),
    checked: ctx.eff(spec.field) !== false,
    disabled: !ctx.writable,
    onToggle: () => {
      ctx.setField(spec.field, ctx.eff(spec.field) === false);
    },
  });
}

/** 三枚开关行（总开关 / 压缩建议 / metrics 落盘）。 */
function buildToggleRows(ctx: RowCtx): {
  enableRow: ReactNode;
  suggestRow: ReactNode;
  metricsRow: ReactNode;
} {
  return {
    enableRow: buildToggleRow(ctx, ENABLED_FIELD),
    suggestRow: buildToggleRow(ctx, SUGGEST_FIELD),
    metricsRow: buildToggleRow(ctx, METRICS_PERSIST_FIELD),
  };
}

/** 数字行：min/max 与 host 侧 Config schema 的钳制区间逐条对齐（越界即不写入）。 */
interface NumberFieldSpec {
  field: string;
  label: keyof UiMessages;
  hint: keyof UiMessages;
  min: number;
  max: number;
}

const THRESHOLD_FIELD: NumberFieldSpec = {
  field: "contextThresholdTokens",
  label: "thresholdLabel",
  hint: "thresholdHint",
  min: 1,
  max: 2_000_000,
};
const RATIO_FIELD: NumberFieldSpec = {
  field: "contextRatio",
  label: "ratioLabel",
  hint: "ratioHint",
  min: 0.1,
  max: 0.95,
};
const REMIND_RATIO_FIELD: NumberFieldSpec = {
  field: "remindRatio",
  label: "remindRatioLabel",
  hint: "remindRatioHint",
  min: 0.01,
  max: 0.3,
};
const REMIND_INTERVAL_FIELD: NumberFieldSpec = {
  field: "remindIntervalTokens",
  label: "remindIntervalLabel",
  hint: "remindIntervalHint",
  min: 0,
  max: 1_000_000,
};
const TOOL_COUNT_FIRST_FIELD: NumberFieldSpec = {
  field: "toolCountFirst",
  label: "toolCountFirstLabel",
  hint: "toolCountFirstHint",
  min: 1,
  max: 10_000,
};
const TOOL_COUNT_INTERVAL_FIELD: NumberFieldSpec = {
  field: "toolCountInterval",
  label: "toolCountIntervalLabel",
  hint: "toolCountIntervalHint",
  min: 1,
  max: 10_000,
};
const RETENTION_FIELD: NumberFieldSpec = {
  field: "metricsRetentionDays",
  label: "retentionLabel",
  hint: "retentionHint",
  min: 0,
  max: 3650,
};

function buildNumberRow(ctx: RowCtx, spec: NumberFieldSpec): ReactNode {
  return createElement(NumberInputRow, {
    label: ctx.t(spec.label),
    hint: ctx.t(spec.hint),
    field: spec.field,
    value: ctx.eff(spec.field),
    disabled: !ctx.writable,
    onChange: (field: string, val: unknown) => {
      ctx.setField(field, val);
    },
    onEmpty: (field: string) => {
      ctx.clearField(field);
    },
    min: spec.min,
    max: spec.max,
  });
}

/** 七枚数字行：窗口阈值两枚 + 提醒节奏三枚 + 辅信号两枚与留存天数（序即渲染序）。 */
function buildNumberRows(ctx: RowCtx): {
  thresholdRow: ReactNode;
  ratioRow: ReactNode;
  remindRow: ReactNode;
  remindIntervalRow: ReactNode;
  toolCountFirstRow: ReactNode;
  toolCountIntervalRow: ReactNode;
  retentionRow: ReactNode;
} {
  return {
    thresholdRow: buildNumberRow(ctx, THRESHOLD_FIELD),
    ratioRow: buildNumberRow(ctx, RATIO_FIELD),
    remindRow: buildNumberRow(ctx, REMIND_RATIO_FIELD),
    remindIntervalRow: buildNumberRow(ctx, REMIND_INTERVAL_FIELD),
    toolCountFirstRow: buildNumberRow(ctx, TOOL_COUNT_FIRST_FIELD),
    toolCountIntervalRow: buildNumberRow(ctx, TOOL_COUNT_INTERVAL_FIELD),
    retentionRow: buildNumberRow(ctx, RETENTION_FIELD),
  };
}

/** 保存草稿的落态与写入口（touched 层留在 DgCard，这里只消费）。 */
interface SaveDraftArgs {
  t: Translate;
  value: Record<string, unknown>;
  touched: Record<string, unknown>;
  set: (field: string, value: unknown) => Promise<void>;
  unset: (field: string) => Promise<void>;
  setTouched: (next: Record<string, unknown>) => void;
  setBusy: (busy: boolean) => void;
  setSaveError: (message: string | null) => void;
}

/** 只写差异字段：touched 里为 undefined 的那一位走 unset（= 恢复 schema 默认）。 */
async function saveCardDraft(args: SaveDraftArgs): Promise<void> {
  const { t, value, touched } = args;
  const keys = diffTouched(touched, value);
  if (keys.length === 0) {
    return;
  }
  args.setBusy(true);
  args.setSaveError(null);
  const ops = keys.map((key) => {
    const val = touched[key];
    return val === undefined ? args.unset(key) : args.set(key, val);
  });
  try {
    await Promise.all(ops);
    args.setBusy(false);
    args.setTouched({});
  } catch (error: unknown) {
    args.setBusy(false);
    args.setSaveError(
      `${t("saveFailed")}${String(error instanceof Error ? error.message : error)}`,
    );
    console.error("[ctx-observe] save failed:", error);
  }
}

function DgCard(props: DgCardProps): ReactNode {
  const { t } = props;
  // 头部两行先取成变量：嵌进 createElement 里再调 t() 会超 max-nested-calls 上限。
  const headTitle = t("cardTitle");
  const headDesc = t("cardDescription");
  const [open, setOpen] = useState(props.initialOpen === true);
  // 框架把 slots.register 注入的 hooks.card 映射为 useCard prop（client-runner PropsHooks）——
  // 直接读 props.hooks.card 会崩（props.hooks 不存在）。与 zvec-grep 卡同契约。
  const snap = props.useCard((snapValue) => snapValue);
  // 官方 `ConfigFormSnapshot.value` 在首个快照受理前是 undefined，cardStore 把已到位的
  // 快照落成 `{}`（见下面 cardStore 内 `snap.value ?? {}`）；但 useCard 本身还能整份缺席
  // （DgCardProps.useCard 返回 `TValue | undefined`），那一路没有经过 cardStore 的归一，
  // 所以这里的 `?.` + `?? {}` 是**活守卫**：缺席 → 空对象 → 开关按默认值渲染。
  const value = snap?.value ?? {};
  // 配置表单快照的真实契约：status==='ready' 且 writable 才可写。
  // 官方快照的 writable 是必选 boolean（memory 模式永假），故直接取值即可，
  // 不再 `=== true` 假装它可能是别的形状。snap 缺席时 `snap?.status === "ready"`
  // 为假 → 直接落到只读渲染，右侧的 `snap.writable` 因此已在同一条链里收窄为非空。
  const writable = snap?.status === "ready" && snap.writable;
  // 保存条状态：touched = 用户动过的字段（undefined = 恢复默认/unset）
  const [touched, setTouched] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** 渲染取值：touched 优先，快照兜底（未触碰字段实时跟随外部快照）。 */
  const eff = (field: string): unknown => (field in touched ? touched[field] : value[field]);
  const dirtyKeys = diffTouched(touched, value);
  const dirty = dirtyKeys.length > 0;
  const setField = (field: string, val: unknown): void => {
    setTouched((prev) => ({ ...prev, [field]: val }));
  };
  const clearField = (field: string): void => {
    setTouched((prev) => ({ ...prev, [field]: undefined }));
  };
  const save = async (): Promise<void> =>
    saveCardDraft({
      t,
      value,
      touched,
      set: props.set,
      unset: props.unset,
      setTouched,
      setBusy,
      setSaveError,
    });
  const discard = (): void => {
    setTouched({});
    setSaveError(null);
  };
  const header = buildCardHeader({
    title: headTitle,
    description: headDesc,
    open,
    onToggle: () => {
      setOpen(!open);
    },
  });
  const sectionTitle = createElement(
    "div",
    {
      className: "coc-section-title",
      style: {
        fontSize: "12px",
        fontWeight: 600,
        color: "var(--dsw-alias-label-secondary,#5c626e)",
        margin: "6px 0 2px",
      },
    },
    t("metricsHeading"),
  );
  const metricsSection = createElement(MetricsSection, { t });
  const rowCtx: RowCtx = { t, eff, writable, setField, clearField };
  const { enableRow, suggestRow, metricsRow } = buildToggleRows(rowCtx);
  const {
    thresholdRow,
    ratioRow,
    remindRow,
    remindIntervalRow,
    toolCountFirstRow,
    toolCountIntervalRow,
    retentionRow,
  } = buildNumberRows(rowCtx);
  const saveBar = createElement(SaveBar, {
    t,
    dirty,
    writable,
    busy,
    error: saveError,
    onSave: () => {
      void save();
    },
    onDiscard: discard,
  });
  return createElement(
    "li",
    { className: `coc-card${open ? " coc-card-open" : ""}` },
    header,
    open
      ? createElement(
          "ul",
          { className: "coc-body" },
          sectionTitle,
          metricsSection,
          enableRow,
          suggestRow,
          metricsRow,
          thresholdRow,
          ratioRow,
          remindRow,
          remindIntervalRow,
          toolCountFirstRow,
          toolCountIntervalRow,
          retentionRow,
          saveBar,
        )
      : null,
  );
}

/**
 * 本卡用到的 ctx 面：三位里两位直接投影官方服务面，不再手抄签名。
 *
 * - `effect`：cordis 官方效应面（installed `@deepseek-ai/cordis/lib/types/fiber.d.ts:8`
 *   的 `interface Context extends Pick<Fiber, 'effect'>`，:157/:159 两个重载）。
 * - `slots`：官方 `SlotRegistry`（renderer 把它增强进 cordis `Context`，installed
 *   `dsh-client-ui-renderer/lib/types/client/index.d.ts:27`）的**方法面投影**。取 `Pick`
 *   而不是 `Context["slots"]` 整个类型：`SlotRegistry` 是带 private 字段的 cordis
 *   `Service` 类（同目录 `registry.d.ts:46`），TS 对它做名义比较，测试桩件无法满足。
 *   `register` 逐字复用 `SlotCore['register']`（`registry.d.ts:85`，两个重载），
 *   `inject` 是 `registry.d.ts:111` 的「按槽位声明生命周期装 effect」那一位（disposer
 *   随 collapse 重跑工厂的语义就写在 :100）。合并进 `SlotMap` 的槽位键在这里是
 *   **编译期受检**的：`inject`/`register` 的 key 参数域就是 `keyof SlotMap & string`。
 * - `configForms`：只投影用到的 `get`。官方 `ConfigForms.get` 是泛型
 *   （`<T>(entryId) => ConfigForm<T>`，installed `config-form.d.ts:142`），且
 *   `ConfigForms` 同样是 Service 类 → 既不能整类型用，也不能把 `Pick` 交给桩件；
 *   这里把 `T` 钉在本卡唯一取的那张表单上，返回面仍是官方 `ConfigForm`。
 * - `locale`：**仍是本包自己声明的面**。官方服务面在 `@deepseek-ai/dsh-client-locale`
 *   的 `Context.locale` 增强里，而那个包不是本包依赖（ctx-observe/node_modules 与
 *   workspace store 下均零命中），本轮不新增依赖，故这一位保持现状。
 */
export interface ClientCtx {
  effect: Context["effect"];
  slots: Pick<SlotRegistry, "inject" | "register">;
  configForms: {
    get: (entryId: string) => EntryForm;
  };
  /**
   * 官方 `@deepseek-ai/dsh-client-locale` 的 client 面（`LocaleRuntime`，installed
   * `lib/types/client/index.d.ts`）在本卡实际用到的那两条重载上的投影：
   * - `bind`：官方**类型化**那条（`bind<N extends Extract<keyof LocaleNamespaceMap,
   *   string>>(ns: N): TranslateNS<N>`）。本包命名空间已 merge 进 `LocaleNamespaceMap`
   *   （见 ui-messages.ts），故取在 `typeof NS`（= 本包条目 id 的字面量）上就是官方
   *   `TranslateNS<'ctx-observe'>`：键集由官方表达，本地不再手写函数形状。
   *   顺带白拿一条漂移保护——`NS` 若与 merge 的命名空间分叉，官方两条重载都对不上
   *   （类型化那条约束不满足、未类型化那条返回 `Translate<string>` 又不兼容窄键集），
   *   这一位当场红。
   *   ⚠ 不写成 `LocaleRuntime['bind']`：那会把官方**未类型化**的重载（返回
   *   `Translate<string>`）一起带进目标类型，任何单一实现都满足不了两条（实测
   *   `Type 'string' is not assignable to type 'LocaleKeysOf<"ctx-observe">'`）。
   * - `register`：官方**类型化**那条（`register<N extends Extract<keyof
   *   LocaleNamespaceMap, string>>(ns: N, dicts: Record<BuiltInLocaleId,
   *   LocaleDictOf<N>>)`），取在 `typeof NS` 上：字典参数是官方 `LocaleDictOf<NS>`
   *   （= 本包键的有限映射），两语必须一次交齐。
   *   ⚠ 不用官方那条未类型化的三参重载（`dict: LocaleDict = Record<string, string>`）：
   *   `UiMessages` 按 lint 的 `consistent-type-definitions` 必须是 `interface`，而
   *   interface 拿不到隐式索引签名，实测
   *   `Index signature for type 'string' is missing in type 'UiMessages'`。走有限键映射
   *   那条既满足官方契约、又让「少一门语言」「多一个键」都在编译期红。
   */
  locale: {
    register: (ns: typeof NS, dicts: LocaleCatalog) => () => void;
    bind: (ns: typeof NS) => Translate;
  };
}

function cardStore(scope: EntryForm): {
  getSnapshot: () => CardSnapshot;
  subscribe: (listener: () => void) => () => void;
} {
  // 缓存必须 per-scope（闭包内）：模块全局会在多 scope 交错 getSnapshot 时互相
  // 冲 memo，导致 useSyncExternalStore 每次拿到新引用 → 无限重渲染。官方也承诺
  // 快照引用在下次变更前稳定，故身份比较成立。
  let cachedSnap: ConfigFormSnapshot<Record<string, unknown>> | null = null;
  let cachedView: CardSnapshot | null = null;
  const EMPTY_SNAPSHOT: CardSnapshot = { status: "loading", writable: false, value: {} };
  return {
    getSnapshot: () => {
      const snap = scope.getSnapshot();
      if (snap !== cachedSnap) {
        cachedSnap = snap;
        cachedView = {
          status: snap.status,
          writable: snap.writable,
          // 官方 value 在首个快照受理前是 undefined，这里落到空对象供渲染。
          value: snap.value ?? {},
        };
      }
      return cachedView ?? EMPTY_SNAPSHOT;
    },
    subscribe: (listener) => scope.subscribe(listener),
  };
}

const inject = ["slots", "configForms", "locale"];

function apply(ctx: ClientCtx): void {
  ctx.effect(() => {
    const tag = document.createElement("style");
    tag.id = "ctx-observe-card-css";
    tag.textContent = CARD_CSS;
    document.head.append(tag);
    return () => {
      tag.remove();
    };
  }, "ctx-observe-card: styles");
  // 0.1.7：配置表单按 **profile 条目 id** 取（= 本包 cordis.patch.yml 里的裸 id
  // `ctx-observe`，与 host 侧隐式 settings 命名空间同源；host.test.ts 钉住该 id）。
  const scope = ctx.configForms.get(NS);
  const store = cardStore(scope);
  // 卡片文案交给官方 locale：把本包两语字典一次性交给**类型化**那条 register 重载
  // （官方要求每个内置 locale 都在，缺一门即编译期红；disposer 随 effect 回收），再
  // bind 出稳定的取文案函数交给卡片。语言切换由宿主驱动 slot 重渲染，无需重载页面。
  ctx.effect(() => ctx.locale.register(NS, UI_MESSAGES), "ctx-observe-card: locale dictionaries");
  const t = ctx.locale.bind(NS);
  ctx.slots.inject("plugins.bundle.config", () => {
    const unregister = ctx.slots.register(
      {
        // 0.1.6：settings.plugin.item 已删除；plugins.bundle.config 按 bundle 包名 keyed
        // （key 用 BUNDLE_PKG，**不是** NS——NS 只喂 configForms.get()，见文件头）。
        name: "plugins.bundle.config",
        key: BUNDLE_PKG,
        inject: () => ({
          t,
          hooks: { card: store },
          // 写入透传表单，失败面保持 0.1.6 的形状：只有 Promise 拒绝（传输失败）才
          // 走卡片的 saveerr + console.error。受理位（false = 宿主拒绝/写入被跳过）
          // 在这是**故意不消费**的 —— 消费它要新增文案键与判定，属改行为而不是迁移
          // （见 ConfigForm 注释；session-rescue 同一条纪律）。
          set: async (field: string, value: unknown): Promise<void> => {
            await scope.set(field, value);
          },
          unset: async (field: string): Promise<void> => {
            await scope.unset(field);
          },
        }),
      },
      DgCard,
    );
    // disposer 只 unregister()，**不 dispose 表单**：0.1.7 的 `configForms.get(entryId)`
    // 交回的是 provider 自己持有的共享表单（installed config-form.d.ts:138-142
    // "The entry's form, owned by this provider"），`ConfigForm` 面上根本没有 dispose
    // （同文件 config-form-types.d.ts:36-74）。slot collapse 会调用本 disposer 并在再次
    // 声明时**重跑工厂**（installed dsh-client-ui-renderer/lib/types/client/
    // registry.d.ts:100 "Collapse disposes the effect and a later declaration runs it
    // again"）——表单是共享且长活的，所以重跑后写入依然落盘；旧 `settingsScope` 那种
    // 「离开插件页一次之后 scope 永久 disposed、之后每次保存被静默丢弃」的坑（0.1.6 的
    // fiber 级 dispose，现由 installed lib/client.js:1213 的 disposed 早退返回 false
    // 承接）随该服务一起消失。
    return unregister;
  });
}

export { inject, apply, NumberInputRow, DgCard, MetricsSection, SaveBar };
