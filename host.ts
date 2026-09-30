// ctx-observe host 半：上下文用量观测 + 战略压缩建议 + metrics 端点。
//
// ECC（MIT）suggest-compact + cost-tracker 移植，按 dsh 改写：
//   - usage 来源：官方折叠口径（packages/llm/token-meter usage-projection.ts
//     的 usageOf）——assistant/message 的 data.usage 优先，缺席回落
//     data.stream 内最后一个 type:'usage' 原始 chunk；assistant/attempt
//     （未落 surface 的废弃/重试结算）只有 stream 一条路；
//   - 注入点：agent/pre-step waterfall（around 中间件：先 next() 取下游决策，
//     再把建议块追加进决策消息末尾，下游已认领的 messages 原样保留）；
//   - 建议非强制：ECC 设计原话"由你判断当前是否是合适的压缩点"；提醒名额在
//     建议真的注入决策后才消费（见 lib/usage-watch.ts 的 RemindProposal）；
//   - metrics：每回合 token 流水落 JSONL（ECC cost-tracker 的教训——
//     前版读错字段 52 天 2340 行全 0；dsh 直接读事件 usage 字段无此风险），
//     webServer GET /_dsh/ctx-observe/metrics 聚合分片返回最近摘要。
//
// 落盘位置：`$DSH_HOME/cache/ctx-observe/`（无 DSH_HOME 则 `~/.dsh/cache/ctx-observe/`），
// 由 @deepseek-ai/dsh-home-paths 的 dshHomePath('cache', …) 单源解析（与官方 dshCachePath
// 的字符串重载逐字节同结果——0.1.x 里 dshCachePath(segment, …) 的实现就是
// dshHomePath('cache', segment, …)；这里保留显式的两段写法，不为此换调用名）。选 cache 是因为 dsh
// 承认的数据目录只有 sessions/ storages/ cache/ logs/，而 token 流水属「可丢弃的
// 派生数据」——真源在 session 事件流，删了不丢事实；旧版自制的 `<home>/metrics/`
// 是用户数据目录里的违建。子目录是本包的命名空间：cache/ 各插件共用，读写与留存
// 回收都只进 `cache/ctx-observe/`，别人的缓存既不被聚合、也不被回收。
//
// 分片纪律：metrics/audit 一律按 pid 分片
// （ctx-observe.<pid>.jsonl / pre-step-audit.<pid>.jsonl）。Session.append
// 在提交事件后同一同步帧里派发 session/event（core/session index.ts:744-770
// 是同步洪流），本插件在其上做 IO；旧版"进程级单一 JSONL + 超限时
// readFileSync+writeFileSync 截断重写"在并发进程下必然丢行/交错（A 重写期间
// B 的 append 落在截断与写回之间）。分片把每个文件收敛成单写者：只有本进程写、
// 也只有本进程收缩自己的分片，跨进程无共享 inode，无需锁即成立。读取端聚合
// 全部分片并按行首 ts 排序（分片之间没有全局写序）。
//
// 运行方式：dsh cordis Loader 直接 import 本 .ts（Node ≥22.18 类型剥离）。

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
// 0.1.7 设置面要求宿主 fork：只有 @deepseek-ai/schemastery 的 resolve 会把
// volatile 字段包成 Volatile 引用（vendor/schemastery/src/index.ts:521-526），
// 公共 schemastery@3.18.0 既没有 .volatile()，解析出来的也仍是普通值。
import Schema from "@deepseek-ai/schemastery";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import type { Context, Fiber, Volatile } from "@deepseek-ai/cordis";
// 值导入：`brandString` 是官方幻影品牌唯一的合法构造口（用在 SessionId 那一位上，见
// preStepPayloadOf）。恒等函数，且官方自述 dsh-brand 不保留运行时身份 ⇒ 口径 A 把它落在
// dependencies、产物留裸说明符（挪回 devDependencies 会被内联成第二份实现，
// test/build-host.test.ts 钉住"说明符在 + 函数体不在"）。与 danger-guard 的 `brandNumber`、
// session-rescue/lesson-loop/dir-prep-organize 的 `brandString` 同一处、同一理由。
import { brandString } from "@deepseek-ai/dsh-brand";
// 路由字面量的类型锚点：`register(route: WebRoute)` 让 kind 与 handler 形参都由官方交出。
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import type { SettingsForms } from "@deepseek-ai/dsh-settings";
import type {
  RequestContext,
  Session,
  SessionEventMap,
  SessionEventType,
  SessionHeader,
  SessionId,
} from "@deepseek-ai/dsh-session";
import type { TokenUsage } from "@deepseek-ai/dsh-llm";
import {
  UsageWatch,
  DEFAULT_INTERVAL,
  DEFAULT_TOOL_FIRST,
  DEFAULT_TOOL_INTERVAL,
  FALLBACK_WINDOW,
} from "./lib/usage-watch.ts";
import { findPreStepAnomalies } from "./lib/prestep-audit.ts";
import { MESSAGES } from "./lib/messages.ts";
import type { CtxObserveMessages } from "./lib/messages.ts";
// host 侧文案语言跟官方 locale 插件的偏好同源：读它拥有的 settings 命名空间（未注册即中文）。
import {
  LOCALE_SETTINGS_NAMESPACE,
  messagesFor,
  resolveLocalePreference,
} from "@jayyuen66/dsh-plugin-shared/lib/locale";
import { fieldOf, isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { shrinkJsonlTail } from "@jayyuen66/dsh-plugin-shared/lib/jsonl";
// F1 信任闸门：本包的端点此前只有自家的 `siteOf` + `sec-fetch-site` 一段（已随此收敛删除）。
import { guardTrust } from "@jayyuen66/dsh-plugin-shared/lib/trust";
import { queryParam } from "@jayyuen66/dsh-plugin-shared/lib/http";

/**
 * 本包在 dsh 共享面里的身份 id（= cordis.patch.yml 的条目 id，也是插件名末段）。
 * 三处投影同源：具名 logger 的名字、`cache/` 下认领的子目录名、分片文件名前缀——
 * 它们表达的都是「这块领地归 ctx-observe」，而不是三个各自可改的值。
 */
const PLUGIN_NAMESPACE = "ctx-observe";

/** 官方 pre-step waterfall 的总线事件名（建议注入器与两枚审计探针都挂这条）。 */
const PRE_STEP_EVENT = "agent/pre-step";

const METRICS_PATH = "/_dsh/ctx-observe/metrics";

/** 落盘文件名前缀（分片名 = `<prefix>.<pid>.jsonl`）。 */
const METRICS_PREFIX = PLUGIN_NAMESPACE;
const AUDIT_PREFIX = "pre-step-audit";

/**
 * 本包在 dsh `cache/` 下认领的子目录名。
 *
 * 为什么是 cache：dsh 承认的数据目录只有 sessions/ storages/ cache/ logs/，
 * 其中 `cache/` 的语义是「可丢弃的派生数据」。每回合 token 流水正是这类——
 * 真源在 session 事件流里，流水只是离线分析的输入，删了不丢事实。旧版自造
 * `<home>/metrics/` 属用户数据目录里的违建，发布出去就是每家插件一套目录名。
 * 为什么还要子目录：`cache/` 是所有插件共用的命名空间，`cache/ctx-observe/`
 * 才是本包的私有领地——读侧聚合与留存回收都只扫这里，别人的缓存既进不了
 * 聚合结果，也不会被本进程的回收删掉。
 */
const CACHE_SUBDIR = PLUGIN_NAMESPACE;

/**
 * metrics/audit 目录：惰性求值（测试重定向 DSH_HOME 需在每次写入时生效）。
 *
 * 路径解析整体交给 `@deepseek-ai/dsh-home-paths`：`DSH_HOME` → `~/.dsh` 的优先
 * 级、空白值视为未设、`~` 展开等口径由官方单源保证（旧版那套
 * `DSH_HOME → HOME/.dsh → throw` 的三态自制实现是三家插件里的重复品之一）。
 * 官方函数只算路径不建目录，目录仍由 appendShardLine 按需创建。
 */
function metricsDir(): string {
  return dshHomePath("cache", CACHE_SUBDIR);
}

/** 本进程独占的分片文件（单写者 → 追加与收缩都无跨进程竞态）。 */
function shardFile(prefix: string): string {
  return path.join(metricsDir(), `${prefix}.${String(process.pid)}.jsonl`);
}

/** audit 分片落盘位置（与 metricsFile 同款惰性求值纪律）。 */
function auditFile(): string {
  return shardFile(AUDIT_PREFIX);
}

/** metrics 分片落盘位置。 */
function metricsFile(): string {
  return shardFile(METRICS_PREFIX);
}

/** 单个分片的大小上限：JSONL 每条 assistant/message 追加一行、无轮转会无界增长；
 *  超限按行对半收缩到限内（不切断 JSON 行），上限外旧行丢弃。分片限的是"本进程这一份"
 *  的体积；跨进程的总量由下面的留存回收兜住（否则每启动一次就永久多一份）。 */
const METRICS_MAX_BYTES = 5 * 1024 * 1024;

/** 一天的毫秒数（留存期计算用）。 */
const DAY_MS = 86_400_000;

/** 分片留存默认天数：属主不是本进程、且末次写入早于此期限的分片会被回收。
 *  0 = 永久保留（关闭回收）。 */
const METRICS_RETENTION_DAYS_DEFAULT = 30;

/** 留存判定的输入（目录项：文件名 + 末次写入时间）。 */
export interface ShardEntry {
  name: string;
  mtimeMs: number;
}

/** 从分片文件名取属主 pid（`<prefix>.<pid>.jsonl`）；旧版单文件与其它文件 → undefined。 */
function shardOwnerPid(name: string, prefixes: readonly string[]): number | undefined {
  let owner: number | undefined;
  for (const prefix of prefixes) {
    const raw = new RegExp(`^${prefix}\\.(?<pid>\\d+)\\.jsonl$`, "u").exec(name)?.groups?.["pid"];
    if (owner === undefined && raw !== undefined) {
      const parsed = Number(raw);
      owner = Number.isSafeInteger(parsed) ? parsed : undefined;
    }
  }
  return owner;
}

/**
 * 分片留存决策（纯函数，可单测）：**只回收别的进程写完的那一份**。
 *
 * 依据是单写者纪律——写侧永远只落在 `shardFile()`（本 pid）上，所以「pid 不是本进程」
 * 且「末次写入早于留存线」的分片不可能再被追加，删掉不丢任何在途数据。
 * retentionDays ≤ 0 表示不回收（永久保留）。
 */
export function planShardSweep(
  entries: readonly ShardEntry[],
  opts: {
    nowMs: number;
    currentPid: number;
    retentionDays: number;
    prefixes: readonly string[];
  },
): string[] {
  const stale: string[] = [];
  if (opts.retentionDays <= 0) {
    return stale;
  }
  const cutoff = opts.nowMs - opts.retentionDays * DAY_MS;
  for (const entry of entries) {
    const owner = shardOwnerPid(entry.name, opts.prefixes);
    if (owner !== undefined && owner !== opts.currentPid && entry.mtimeMs < cutoff) {
      stale.push(entry.name);
    }
  }
  return stale;
}

/** 启动时回收过期分片。只扫本包自己的 cache 子目录（cache/ 各插件共用，别家的
 *  缓存文件不在删除权限内）。目录还不存在（首次运行）直接跳过；其余失败只 warn——
 *  清理是磁盘卫生，不是功能，不能因此炸掉插件。 */
function sweepStaleShards(retentionDays: number, log: Log): number {
  let removed = 0;
  try {
    const dir = metricsDir();
    if (!existsSync(dir)) {
      return 0;
    }
    const entries: ShardEntry[] = readdirSync(dir).map((name) => ({
      name,
      mtimeMs: statSync(path.join(dir, name)).mtimeMs,
    }));
    for (const name of planShardSweep(entries, {
      nowMs: Date.now(),
      currentPid: process.pid,
      retentionDays,
      prefixes: [METRICS_PREFIX, AUDIT_PREFIX],
    })) {
      rmSync(path.join(dir, name), { force: true });
      removed += 1;
    }
  } catch (error) {
    // 直接把 error 交给 logger：保留 code/stack，比手工摘要更可读，也避免
    // "Error / 非 Error"两分支里那条永远测不到的字符串化支路。
    log.warn("[ctx-observe] 分片回收跳过（cache/ctx-observe 目录不可读）", error);
  }
  return removed;
}

/** 超限时按行对半收缩直到 ≤ maxBytes（单行即可超限时保留最后 1 行兜底；
 *  任何失败静默——截断不影响追加主流程）。
 *  同步必需——本链运行在 session/event 热路径事件分发内，async 追加会乱序丢条，
 *  且测试直接调用同步链。"该留哪些行"的判据在 `shared/lib/jsonl.ts`（SP-D 收敛），
 *  读盘/写盘与"变了才写"留在这里：单写者前提下（分片只有本进程写）截断重写不与其它进程交错。 */
export function trimMetricsFile(file: string, maxBytes: number = METRICS_MAX_BYTES): void {
  try {
    if (statSync(file).size <= maxBytes) {
      return;
    }
    const text = readFileSync(file, "utf8");
    const shrunk = shrinkJsonlTail(text, maxBytes);
    if (shrunk === text) {
      return;
    }
    writeFileSync(file, shrunk);
  } catch {
    /* 截断尽力而为 */
  }
}

/** session/event 载荷的防御投影（入参是宿主送来的 unknown，故各位均可缺）。
 *  字段类型逐位取自官方声明：turn/stream 取 `assistant/message`，contextWindow 取
 *  `request/context` 折叠出的 RequestContext——官方改名或换类型即在本地编译失败，
 *  不再靠注释手抄 d.ts 行号。 */
interface ObservedEvent {
  type?: SessionEventType;
  data?: {
    turn?: SessionEventMap["assistant/message"]["turn"];
    usage?: UsageLike;
    /** 不透明序列：本包只逐项探形找 usage 块（usageFromStream），不依赖元素结构，
     *   故不绑官方 AssistantStreamRecord——绑了就得逐元素校验，而这里没有校验。 */
    stream?: readonly unknown[];
    contextWindow?: RequestContext["contextWindow"];
  };
}

/** 官方 `TokenUsage` 的「按位可缺」投影：provider 少报某位时本包按缺失处理。 */
type UsageLike = Partial<TokenUsage>;

/** native pressure 口径：input + cacheRead + cacheWrite（不含 output）；仅当
 *  inputTokens 缺失（个别 provider 只报聚合 totalTokens）时回退 totalTokens。 */
function pressureTokens(usage: UsageLike): number {
  if (typeof usage.inputTokens === "number") {
    return (
      usage.inputTokens +
      (typeof usage.cacheReadTokens === "number" ? usage.cacheReadTokens : 0) +
      (typeof usage.cacheWriteTokens === "number" ? usage.cacheWriteTokens : 0)
    );
  }
  return typeof usage.totalTokens === "number" ? usage.totalTokens : 0;
}

/**
 * pre-step 载荷里本包读到的 header 两位 = **官方 `SessionHeader` 的投影**（installed
 * `@deepseek-ai/dsh-session/lib/types/types.d.ts`：`readonly origin?: 'subagent'` :81、
 * `readonly delegationDepth?: number` :87）。此前这里是 `Record<string, unknown>`——那既不是
 * 官方的键名集合（改名字本包静默看不见），也不约束值域（`origin` 官方只认 `'subagent'` 一枚
 * 字面量）。`headerView` 把边界上读来的 unknown 逐位收成官方形状：非数字的 depth、非
 * `'subagent'` 的 origin 一律**丢弃**，与迁移前 `typeof === "number"` / `!== "subagent"` 的
 * 判定结果逐档相同。
 */
type SessionHeaderView = Pick<Partial<SessionHeader>, "delegationDepth" | "origin">;

/** pre-step 载荷投影后的 agent 形状。id / header / requestContext 三个成员由
 *  真实 Session 保证存在（installed `@deepseek-ai/dsh-session/lib/types/index.d.ts`：
 *  `get id(): SessionId` :122、`readonly header: SessionHeader` :118、
 *  `requestContext(): RequestContext | undefined` :267），故此处声明为必选：投影拿不到
 *  即说明载荷不是真实 Session，整条建议链退出（fail-closed）而不是假装看得见。
 *  `id` 就此是官方品牌的 `SessionId`（幻影品牌串，见下面 headerView 之后的构造点）。 */
interface PreStepAgent {
  session: {
    id: Session["id"];
    header: SessionHeaderView;
    /** 宿主 `requestContext()` 的**原始**返回（边界值，值域未校验）：调用点按
     *  `unknown` 逐位取值，见 pre-step 兜底读权威窗口处。声明成 `() => unknown` 而不是
     *  `Session["requestContext"]`，是因为投影这里只是将宿主函数原样转手 —— 把返回标成
     *  `RequestContext | undefined` 就得写窄化断言（typescript/no-unsafe-type-assertion 禁），
     *  而把它收成官方形状又等于替宿主担保值域。 */
    requestContext: () => unknown;
  };
}

/**
 * 0.1.7 的 settings 服务只剩两件事在本包有用（`register`/`get` 已被宿主移除）：
 *   - `configure(presentation, owner)`：声明本页不走宿主自动生成（本包自带卡片）；
 *   - `describe()`：跨命名空间读的**唯一**入口——返回全部条目的表单投影，
 *     本包只从里面挑 `ns === 'locale'` 那一条的 `value`（官方 dsh-client-locale
 *     的 `Config = { preference: z.string()...volatile() }`，故它会被投影出来）。
 * 服务面直接取官方 `SettingsForms`（dsh-settings 已把 `settings` 增强进 cordis Context），
 * 不再本地投影 describe 的返回形状。
 */
interface InjectedCtx {
  settings: SettingsForms;
  /** 官方效应面（`interface Context extends Pick<Fiber, 'effect'>`，两条重载）；
   *  本地不再重述工厂的入参与返回形状。 */
  effect: Context["effect"];
}

/**
 * 宿主事件回调在本插件用到的两种形状：
 *   - 普通分发（session/event、session/disposed）：(payload, extra?)；
 *   - waterfall（agent/pre-step）：(payload, next)，next 是"调用下游"的契约句柄。
 * 真实 Context.on 按事件名在 Events 接口里逐事件定型（cordis events.ts:97），
 * 本投影取两种形状的联合，回调据实标注参数类型即可——避免旧实现用 `as never`
 * 谎报监听器签名（never 比原类型更窄，本身就是 unsafe assertion）。
 */
type HostListener =
  | ((payload: unknown, extra?: unknown) => unknown)
  | ((payload: unknown, next: () => Promise<unknown>) => unknown);

/** 宿主 logger 的本包用面（官方 `ctx.logger(name)` 具名 facade 的方法子集）。
 *  结构化最小声明：不 import cordis 类型，测试桩件给个同形对象即可。 */
interface Log {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

interface HostCtx {
  settings: SettingsForms;
  /** 具名 logger 服务（cordis-api/context.md:131-138）。缺席（异常 ctx/旧桩件）→
   *  回退 console——回退是**兼容路径**不是常态路径，测试两条都覆盖。 */
  logger?: (name: string) => Log;
  /** 隐式注册后本包不再持有 scope，只经子上下文挂页面策略（宿主 client-locale 同款）。
   *  ⚠ deferred（与下面 `on` 同一批，本轮不转换）：不绑 `Context["inject"]`——官方那一位是
   *  `inject(deps, callback: Plugin.Function<void>)`（installed
   *  `@deepseek-ai/cordis/lib/types/registry.d.ts:111`），而 `Plugin.Function` 的形状是
   *  `(ctx: Context, config: T) => any`（同文件 `:71-73`）：回调拿到的是**完整 Context**，
   *  本包收窄过的子上下文（只有 settings + effect）会被整体换回宿主面。 */
  inject: (deps: readonly string[], callback: (child: InjectedCtx) => void) => unknown;
  /** 本插件 fiber：`configure` 的 owner 必须显式传它（缺省是 settings 服务自己的 fiber）。 */
  fiber: Fiber;
  /** 官方效应面（`interface Context extends Pick<Fiber, 'effect'>`，两条重载）；
   *  本地不再重述工厂的入参与返回形状。 */
  effect: Context["effect"];
  /** 第三参 options.prepend=true → unshift 到 index 0 → 瀑布最外层
   *  （实现见 vendor/cordis/src/events.ts register()/waterfall()）。
   *  ⚠ deferred（与上面 `inject` 同一批，本轮不转换）：不绑 `Context["on"]`——官方那一位是
   *  `on<K extends keyof Events>(name: K, listener: Events[K], …)`（installed
   *  `@deepseek-ai/cordis/lib/types/events.d.ts:88`），**逐事件**定形：`session/event` 是位置参
   *  `(session, event)`、`session/disposed` 是 `(session)`（installed
   *  `@deepseek-ai/dsh-session/lib/types/index.d.ts:63` 与 `:51`），而 `agent/pre-step` 根本不在
   *  本包的编译程序里（它由 `@deepseek-ai/dsh-agent` 增强进 `Events`，该包不是本包依赖）。
   *  绑上去要先改写 5 处监听器的签名（含 waterfall 的返回类型），并单独评估本包这些按
   *  `unknown` 收参的防御投影在官方形状下是否仍然可达——故与 `inject` 同批 deferred。 */
  on: (event: string, listener: HostListener, options?: { prepend?: boolean }) => unknown;
  /** 服务读取面直接取官方 `Context["get"]`（installed
   *  `@deepseek-ai/cordis/lib/types/reflect.d.ts:14`：
   *  `get<K extends string & keyof this>(name: K, strict?: boolean): undefined | this[K]`）。
   *  本包只读 `webServer` 这一枚**已声明**的服务名——`@deepseek-ai/dsh-host-webserver` 把它
   *  增强进了 `Context`（installed `lib/types/index.d.ts:15-18` `webServer: WebServer`），
   *  故读回来的形状由官方直接交出，既不需要断言，也不需要本地的 `Pick` 投影。
   *  返回域里的 `undefined` 是官方语义（"or `undefined` when not (yet) provided"），
   *  不是类型装饰——而且 **"yet" 是这里的关键**：真实宿主上 webServer 晚于本条目到位，
   *  故 metrics 端点的注册走 `svc.inject(["webServer"], …)` 的子 fiber，只在效应里做
   *  一道契约兜底（见下方 metrics 端点那条注释）。 */
  get: Context["get"];
}

/**
 * 空 disposer：官方 `Context['effect']` 的工厂返回域是 `SyncEffect` / `Effect`
 *（installed `@deepseek-ai/cordis/lib/types/fiber.d.ts:49-50`），两支都**不受理
 * `undefined`**——「这一趟没有要清理的东西」在官方契约里是一枚空 disposer，而不是
 * 缺省返回。旧代码写 `return;` / 让函数走到末尾，是被本地那份比官方宽的效果面镜像
 * （`(factory: () => (() => void) | undefined, …) => void`）惯出来的；`effect` 改绑
 * 官方后那两处当场红（TS2769），这里按官方形状补齐。
 */
const NOOP_DISPOSER = (): void => {
  void 0;
};

/** 异常摘要（宿主侧/抛非 Error 的监听器都可能送到这里，统一收成一行文本）。
 *  连 String() 本身都可能抛（无原型对象 `Object.create(null)` 转原始值失败），
 *  而本函数的调用点全在热路径的 catch 里——那里再抛一次就是打断宿主事件分发。 */
function describeError(error: unknown): string {
  let message: string;
  try {
    message = error instanceof Error ? error.message : String(error);
  } catch {
    message = "unstringifiable error";
  }
  return message;
}

/** 同步落一行到分片：建目录 + 收缩 + 追加。同步必需——热路径事件分发内同步
 *  完成，async 追加会乱序丢条；整条命中原样保序写入。 */
function appendShardLine(file: string, line: string): void {
  const dir = path.dirname(file);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  trimMetricsFile(file);
  appendFileSync(file, line);
}

/** 落一行 metrics。**不变式：热路径绝不抛**——路径解析与建目录/截断/追加全在
 *  同一个 try 里，任何失败都只记一条日志并丢掉这一行。本函数运行在
 *  session/event 的同步分发链上，抛错会打断宿主事件分发（少一行流水远好于
 *  整个回合死掉）。解析交给 home-paths 后它本身不再抛（永远有 `~/.dsh` 兜底），
 *  但仍留在 try 内：真抛（例如畸形 env 触发的路径异常）也只是换个错误消息落进
 *  同一条降级出口，不额外开一个测不到的死分支。 */
function appendMetric(row: Record<string, unknown>, log: Log): void {
  try {
    appendShardLine(metricsFile(), `${JSON.stringify({ ts: Date.now(), ...row })}\n`);
  } catch (error) {
    log.error("[ctx-observe] metric append failed:", describeError(error));
  }
}

/** 读一个分片的全部非空行。同步必需——webServer 端点 handler 为同步返回，
 *  端点读取必须在同一次响应内同步完成。 */
function readShardLines(file: string): string[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

/** 本包 cache 子目录内本插件前缀的全部分片：新版 `<prefix>.<pid>.jsonl` 与旧版
 *  单文件 `<prefix>.jsonl`（升级前的历史流水）一并纳入聚合。
 *
 *  前缀判定不能松：`cache/` 是各插件共用的可丢弃数据区，聚合读一旦把邻居的
 *  `*.jsonl` 吞进来，卡片与 context-budget 技能看到的就是别家的流水（读侧只进
 *  `cache/ctx-observe/`，再加这层前缀正则，是双保险）。 */
function listShardFiles(prefix: string): string[] {
  const dir = metricsDir();
  const pattern = new RegExp(`^${prefix}(?:\\..+)?\\.jsonl$`, "u");
  return readdirSync(dir)
    .filter((name) => pattern.test(name))
    .toSorted()
    .map((name) => path.join(dir, name));
}

/** 分片行的 ts（聚合排序用）：行首 `{"ts":<number>` 直取，解析不出 → 0 排最前。 */
function tsOfLine(line: string): number {
  const raw = /^\{"ts":(?<ts>\d+)/u.exec(line)?.groups?.["ts"];
  const value = typeof raw === "string" ? Number(raw) : Number.NaN;
  return Number.isFinite(value) ? value : 0;
}

/** 读全部 metrics 行（端点用）：聚合所有分片并按 ts 升序——分片之间不存在
 *  全局写序，不排序会让"末行即最新"的读法在分片后失效。
 *  去截断（用户拍板"不为省 token 降能力"）：旧实现端点只回末 50 行，
 *  卡片与技能看到的永远只是碎片——改为全量返回；磁盘上限（trimMetricsFile
 *  5MB 保险丝）保持不变，那是磁盘卫生不是能力截断。 */
function readMetricsSorted(): string[] {
  try {
    const lines: string[] = [];
    for (const file of listShardFiles(METRICS_PREFIX)) {
      lines.push(...readShardLines(file));
    }
    return lines.toSorted((left, right) => tsOfLine(left) - tsOfLine(right));
  } catch {
    return [];
  }
}

function readMetricsAll(): string {
  return readMetricsSorted().join("\n");
}

/** `?limit=` 出现但非法（非纯数字或 0）→ true，端点答 400。缺席（null）= 合法缺席。 */
function metricsLimitInvalid(raw: string | null): boolean {
  return raw !== null && (!/^\d+$/u.test(raw) || Number(raw) === 0);
}

function readMetricsLast(limit: number): string {
  return readMetricsSorted().slice(-limit).join("\n");
}

/** 从 unknown 投影为未知元素数组（非数组 → null）。Array.isArray 的窄化产物是
 *  any[]，逐元素搬进显式 unknown[] 才不把 any 带进后续链（no-unsafe-* 纪律）。 */
function messagesOf(value: unknown): unknown[] | null {
  let result: unknown[] | null = null;
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value) {
      items.push(item);
    }
    result = items;
  }
  return result;
}

/** 从 unknown 投影为 UsageLike（非 Record / 字段非 number → 该字段缺失）。 */
function projectUsage(raw: unknown): UsageLike | null {
  if (!isRecord(raw)) {
    return null;
  }
  const result: UsageLike = {};
  const input = raw["inputTokens"];
  if (typeof input === "number") {
    result.inputTokens = input;
  }
  const output = raw["outputTokens"];
  if (typeof output === "number") {
    result.outputTokens = output;
  }
  const cacheRead = raw["cacheReadTokens"];
  if (typeof cacheRead === "number") {
    result.cacheReadTokens = cacheRead;
  }
  const cacheWrite = raw["cacheWriteTokens"];
  if (typeof cacheWrite === "number") {
    result.cacheWriteTokens = cacheWrite;
  }
  const total = raw["totalTokens"];
  if (typeof total === "number") {
    result.totalTokens = total;
  }
  return result;
}

/** 官方 `SessionEventType` 的全集守卫表：宿主送来的 `type` 是运行时字符串，盲转成
 *  联合类型就是不安全断言。用 `Record<SessionEventType, true>` 让编译器强制穷举——
 *  官方新增/改名事件类型时此处直接编译失败，而不是静默把未知类型当合法。 */
const SESSION_EVENT_TYPES: Record<SessionEventType, true> = {
  "turn/start": true,
  "turn/end": true,
  "step/start": true,
  "step/end": true,
  "user/message": true,
  "developer/message": true,
  "system/message": true,
  "assistant/message": true,
  "assistant/attempt": true,
  "tool/call": true,
  "tool/result": true,
  "request/header": true,
  "request/context": true,
  "session/end-seed": true,
};

function isSessionEventType(value: unknown): value is SessionEventType {
  return typeof value === "string" && Object.hasOwn(SESSION_EVENT_TYPES, value);
}

/** session/event 载荷的 event 子投影
 *  （type/data = { turn, contextWindow, usage, stream }）。 */
function eventPayloadOf(eventRaw: unknown): ObservedEvent | null {
  if (!isRecord(eventRaw)) {
    return null;
  }
  const dataRaw = isRecord(eventRaw["data"]) ? eventRaw["data"] : undefined;
  const dataValues: NonNullable<ObservedEvent["data"]> = {};
  const turn = dataRaw?.["turn"];
  if (typeof turn === "number") {
    dataValues.turn = turn;
  }
  const contextWindow = dataRaw?.["contextWindow"];
  if (typeof contextWindow === "number") {
    dataValues.contextWindow = contextWindow;
  }
  const usage = projectUsage(dataRaw?.["usage"]);
  if (usage !== null) {
    dataValues.usage = usage;
  }
  const stream = dataRaw?.["stream"];
  if (Array.isArray(stream)) {
    dataValues.stream = stream;
  }
  const event: ObservedEvent = {};
  const eventType = eventRaw["type"];
  if (isSessionEventType(eventType)) {
    event.type = eventType;
  }
  event.data = dataValues;
  return event;
}

/**
 * stream 回落：倒序取最后一个 `{type:'chunk', chunk:{type:'usage', usage}}`，
 * 逐字对齐官方 lastAssistantStreamChunk(stream,'usage')（命中即停，不看更前的）。
 */
function usageFromStream(stream: unknown): UsageLike | null {
  const records = messagesOf(stream);
  let result: UsageLike | null = null;
  if (records === null) {
    return result;
  }
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const chunk = fieldOf(record, "chunk");
    if (fieldOf(record, "type") === "chunk" && fieldOf(chunk, "type") === "usage") {
      result = projectUsage(fieldOf(chunk, "usage"));
      break;
    }
  }
  return result;
}

/**
 * 事件携带的 usage —— 官方折叠口径（token-meter usage-projection.ts:81-86）。
 *
 * 旧实现只读 assistant/message.data.usage：provider 把 usage 只嵌在 stream 里
 * （assistant/message 无 data.usage）或只在 assistant/attempt 里报账时，本插件
 * 的指标与建议双双静默缺口——窗口阈值明明已过却永远不提醒。
 */
function usageOfEvent(event: ObservedEvent): UsageLike | null {
  if (event.type === "assistant/message") {
    return event.data?.usage ?? usageFromStream(event.data?.stream);
  }
  if (event.type === "assistant/attempt") {
    return usageFromStream(event.data?.stream);
  }
  return null;
}

/** 边界上的可调用守卫：把宿主送来的 `unknown` 收成「this 位由调用方给、返回未校验」的
 *  调用形状。这样就不必写 `as (this: unknown) => …` 那种窄化断言
 *  （typescript/no-unsafe-type-assertion 明确禁），同时也不替宿主的返回值域担保 —— 值域
 *  由读它的那一位自己按 `unknown` 校验。 */
type HostCallable = (this: unknown) => unknown;

function isCallable(value: unknown): value is HostCallable {
  return typeof value === "function";
}

/** 边界上的 header → 官方两位投影：值域不合者一律丢弃（视为缺省），见 SessionHeaderView 注记。 */
function headerView(headerRaw: Record<string, unknown>): SessionHeaderView {
  const { delegationDepth: depth, origin } = headerRaw;
  return {
    ...(typeof depth === "number" ? { delegationDepth: depth } : {}),
    ...(origin === "subagent" ? { origin } : {}),
  };
}

/** pre-step 载荷的 agent 投影；结构不合真实 Session 形状 → null（建议链退出）。 */
function preStepPayloadOf(payloadRaw: unknown): PreStepAgent | null {
  const agentRaw = fieldOf(payloadRaw, "agent");
  const sessionRaw = fieldOf(agentRaw, "session");
  const id = fieldOf(sessionRaw, "id");
  const header = fieldOf(sessionRaw, "header");
  const requestContextRaw = fieldOf(sessionRaw, "requestContext");
  if (typeof id !== "string" || !isRecord(header) || !isCallable(requestContextRaw)) {
    return null;
  }
  // 必须以真实 Session 为 this 调用：requestContext 内部读 this.log /
  // this.contextFoldSeq，解绑调用会以投影对象为 this → TypeError reading
  // 'length'（0.1.6 实证）。
  const session: PreStepAgent["session"] = {
    // 官方 `Session.id` 是品牌 `SessionId`（幻影品牌串，type-only 造不出来，`as` 又被
    // typescript/no-unsafe-type-assertion 禁掉）：值来自宿主自己的 Session 对象，故用官方
    // `brandString`（恒等函数）把已核验是字符串的这一步标回来，而不是把形状降级成 string。
    id: brandString<SessionId>(id),
    header: headerView(header),
    requestContext: (): unknown => requestContextRaw.call(sessionRaw),
  };
  return { session };
}

/** 根会话判定：无 delegationDepth 且 origin !== 'subagent'。两位都按官方投影读。 */
function isRootHeader(header: SessionHeaderView): boolean {
  const depth = header.delegationDepth;
  const depthBig = depth !== undefined && depth > 0;
  return !depthBig && header.origin !== "subagent";
}

/**
 * session/event 载荷里的 session 直接是 Session 实例（header 在顶层），与
 * pre-step 的 isRootHeader（agent.session.header）形状不同，分开判定。
 * 无 header 投影（旧档/测试 mock）→ 保守视为根会话。
 */
function sessionIsRoot(sessionRaw: unknown): boolean {
  if (sessionRaw === null || sessionRaw === undefined) {
    return false;
  }
  const header = fieldOf(sessionRaw, "header");
  if (!isRecord(header)) {
    return true;
  }
  return isRootHeader(headerView(header));
}

/**
 * 两张 Map 的统一容量纪律：while 循环删最旧直到 ≤cap（突发 300 会话一次压回，
 * if 版每事件只删一条、长驻进程持续超限）。永不删 keepId（当前会话）。
 */
export function pruneToCapacity(map: Map<string, unknown>, keepId: string, cap: number): void {
  while (map.size > cap) {
    const keys = [...map.keys()];
    const victim = keys.find((key) => key !== keepId);
    if (victim === undefined) {
      return;
    }
    map.delete(victim);
  }
}

/** 行级配置（组合包层/用户层行的 config:）由 cordis 按导出的 `Config` schema 校验
 *  并填默认后传入 apply。0.1.7 起隐式注册：命名空间 = profile 条目 id
 *  （`ctx-observe`，见 cordis.patch.yml），可编辑字段由 schema 上的 `.volatile()`
 *  声明，不再有 `settings.register` 的第二层「底座」——原 BUILTIN_BASE 逐字段落成
 *  下面的 `.default(...)`，单一来源。volatile 字段以 Volatile 引用形态交进来，
 *  读当前值一律 `.get()`。 */
export interface Config {
  enabled: Volatile<boolean>;
  suggestEnabled: Volatile<boolean>;
  /** 显式绝对阈值：**无默认**（undefined 哨兵，见 schema 注释）。 */
  contextThresholdTokens: Volatile<number | undefined>;
  contextRatio: Volatile<number>;
  remindRatio: Volatile<number>;
  metricsEnabled: Volatile<boolean>;
  /** metrics/audit 分片留存天数（0 = 永久保留、不回收）。 */
  metricsRetentionDays: Volatile<number>;
  /** 无窗口兜底重复间隔（volatile：用户可调的提醒节奏）。 */
  remindIntervalTokens: Volatile<number>;
  /** 辅信号首次提醒的工具调用次数（volatile）。 */
  toolCountFirst: Volatile<number>;
  /** 辅信号重复间隔（volatile）。 */
  toolCountInterval: Volatile<number>;
  /** 假定兜底窗口（非 volatile 部署值：普通值形态，不经 .get()）。 */
  fallbackWindow: number;
}

/** 一次读全的解析后设置快照（本包多处按事件/回合现读，语义同旧 scope.get()）。 */
interface ResolvedSettings {
  enabled: boolean;
  suggestEnabled: boolean;
  contextThresholdTokens: number | undefined;
  contextRatio: number;
  remindRatio: number;
  metricsEnabled: boolean;
  metricsRetentionDays: number;
  remindIntervalTokens: number;
  toolCountFirst: number;
  toolCountInterval: number;
  fallbackWindow: number;
}

/** settings namespace 与 loader 行 config 共用同一 schema（单源，防漂移）。
 *  值名退避为 configSchema：避免与同名 interface Config 触发 no-redeclare；
 *  外部仍以 `Config` 名导入（export as），公开 API 不变。
 *  十个字段全部 volatile —— 没有任何 volatile 字段的条目会被宿主 describe() 整条
 *  跳过（packages/settings/settings/src/index.ts:308-309），写入则抛
 *  `has no volatile fields`（:386）。 */
const configSchema = Schema.object({
  enabled: Schema.boolean().default(true).volatile(),
  // 压缩建议独立开关（有人嫌提醒烦）。
  suggestEnabled: Schema.boolean().default(true).volatile(),
  // 显式绝对阈值（token）：配置后优先于窗口比例；未配置 → 窗口×contextRatio。
  // ⚠ 这里**不能**给 .default()：一旦有默认值，"显式配置优先"就永远命中、
  // 窗口比例永不生效（v5 隐藏 bug 根因）。undefined 哨兵由 volatile 引用本身承载
  // ——fork 的 resolve 对缺字段仍产出引用，其 get() 返回 undefined。
  contextThresholdTokens: Schema.natural().max(2_000_000).volatile(),
  // 窗口比例触发点：contextWindow × contextRatio。默认 0.7（70%）。
  contextRatio: Schema.number().min(0.1).max(0.95).step(0.05).default(0.7).volatile(),
  // 窗口比例重复间隔：contextWindow × remindRatio。默认 0.05（5%）。
  remindRatio: Schema.number().min(0.01).max(0.3).step(0.01).default(0.05).volatile(),
  metricsEnabled: Schema.boolean().default(true).volatile(),
  // 分片留存天数：0 = 永久保留（不回收），上限 10 年（等价于"事实上不回收"）。
  metricsRetentionDays: Schema.natural()
    .max(3650)
    .default(METRICS_RETENTION_DAYS_DEFAULT)
    .volatile(),
  // 无窗口信息（legacy 兜底）时的重复提醒间隔（token）。部署差异点（provider 不报
  // usage 时它是唯一可见节奏），与 toolCount* 一并 volatile 上卡。
  remindIntervalTokens: Schema.natural().default(DEFAULT_INTERVAL).volatile(),
  // tokens 未知时的辅信号：第 N 次工具调用首次提醒。
  toolCountFirst: Schema.natural().default(DEFAULT_TOOL_FIRST).volatile(),
  // 辅信号重复间隔。
  toolCountInterval: Schema.natural().default(DEFAULT_TOOL_INTERVAL).volatile(),
  // 窗口两路都取不到时假定的窗口（token）。非 volatile：部署假定值（占用设置卡），
  // cordis.yml 的 config: 可改；默认与 lib 单源（同枚常量）。
  fallbackWindow: Schema.natural().default(FALLBACK_WINDOW),
});
export { configSchema as Config };

/** 本插件建议消息的 producer-owned source.kind（session-rescue 的
 *  RESCUE_SOURCE_KIND 同款）。0.1.7 的 V4 准入拒收退役包装
 *  `{ kind: 'plugin', plugin }`（session-format-v3-to-v4/src/message-sources.ts
 *  对每个声明的持久消息位抛 "format v4 message requires a producer-owned source
 *  kind"）：本插件追加进 pre-step 决策 `messages` 的建议不是 request-only——
 *  首个 attempt 里宿主逐条 `session.append('user/message', …)`
 *  （core/agent-loop/src/agent.ts:401-404），而 `user/message` 正是被拒的持久位
 *  之一。迁移表把未知插件名统一加 `plugin:` 前缀（sources.ts producerKind），
 *  故本插件已迁移的历史行读回也是同一个串——发出同一串才是同一个身份。 */
const OBSERVE_SOURCE_KIND = "plugin:ctx-observe";

/** 请求体建议消息的最小形状（注入决策消息尾部）。本包不读回它（注入是单向的，
 *  提醒名额由 proposal.commit 记账），source 只剩 producer-owned kind。 */
interface SuggestionMessage {
  id: string;
  role: "user";
  content: { type: "text"; text: string }[];
  source: { kind: typeof OBSERVE_SOURCE_KIND };
}

/** 一条待注入的建议：消息 + 「注入成立后消费提醒名额」的提交口。 */
interface SuggestionProposal {
  message: SuggestionMessage;
  commit: () => void;
}

/** 注入结果：decision 是回传给 waterfall 的值，injected 说明建议是否真的进了消息。 */
interface InjectionOutcome {
  decision: unknown;
  injected: boolean;
}

/**
 * 把压缩建议注入下游决策——只做能做的注入，其余一律原样透传（同一引用）。
 *
 * 三条不透传的判据各有理由：
 *   - 非对象决策：伪造 `{kind:'enter',messages:[suggestion]}` 会把该 step 已
 *     认领的 user messages 全丢掉（harness 默认决策是
 *     `{kind:'enter',messages:[...claimed, context]}`，agent-loop agent.ts:248-252），
 *     代价是用户消息静默蒸发——比少一条建议严重得多。
 *   - reject：下游否决了本 step，建议无意义。
 *   - messages 不是数组：畸形决策（正是 pre-step 探针在找的形状），不接管、
 *     不猜测它认领了什么。
 */
function injectSuggestion(decisionRaw: unknown, suggestion: SuggestionMessage): InjectionOutcome {
  const claimed =
    isRecord(decisionRaw) && decisionRaw["kind"] !== "reject"
      ? messagesOf(decisionRaw["messages"])
      : null;
  let outcome: InjectionOutcome = { decision: decisionRaw, injected: false };
  if (claimed !== null && isRecord(decisionRaw)) {
    // spread 保留 startsRequestSeries 等下游声明；kind 归一为 enter
    outcome = {
      decision: { ...decisionRaw, kind: "enter", messages: [...claimed, suggestion] },
      injected: true,
    };
  }
  return outcome;
}

/** computeSuggestion 的宿主依赖（对象化以便单测，同时受 max-params 约束）。 */
interface SuggestionDeps {
  settingsOf: () => ResolvedSettings;
  /** 取/建该会话的 watcher，并同步 settings 阈值（含清空）与窗口比例。 */
  watcherFor: (sessionId: string) => UsageWatch;
  toolCountOf: (sessionId: string) => number;
}

/**
 * 计算战略压缩建议（绝不抛；null = 本次不注入）。自身 try/catch 吞错——
 * 建议是增强能力，任何异常都不允许杀死回合。
 */
function computeSuggestion(
  payloadRaw: unknown,
  deps: SuggestionDeps,
  log: Log,
): SuggestionProposal | null {
  try {
    const cfg = deps.settingsOf();
    if (!cfg.enabled || !cfg.suggestEnabled) {
      return null;
    }
    const agent = preStepPayloadOf(payloadRaw);
    if (agent === null || !isRootHeader(agent.session.header)) {
      return null;
    }
    const sid = agent.session.id;
    // 这里必须"建"watcher，不能只 watchers.get()。旧实现在
    // watchers 为空时直接早退，而 watcher 只由 session/event 创建——不报 usage
    // 的 provider 于是连 toolCountFirst 辅信号支路都永远进不去。watcherFor
    // 自带 settings 同步与 200 会话容量剪枝。
    // 接收者写上 `UsageWatch`：下面四条判定都打在这台状态机上，把类型面写出来就不必让
    // 静态分析跨一层闭包去反推 deps 上声明的返回类型（调用点与语义一字未改）。
    const watch: UsageWatch = deps.watcherFor(sid);
    // 兜底喂窗口：request/context 事件未达（旧档/插件后装）时，直接从真实
    // Session 读权威 contextWindow（session.requestContext() 折叠 request/context）。
    if (watch.window() === null) {
      // 返回是边界 unknown：`contextWindow` 那一位在这里才收成数字（宿主少报、
      // 报错类型都按缺失处理），故下面的 typeof 判定不是多余的。
      const cw = fieldOf(agent.session.requestContext(), "contextWindow");
      if (typeof cw === "number" && Number.isFinite(cw) && cw > 0) {
        watch.setWindow(cw);
      }
    }
    const proposal = watch.observe(deps.toolCountOf(sid), watch.lastTokens() ?? undefined);
    if (proposal === undefined) {
      return null;
    }
    return {
      message: {
        id: `ctx-observe-${randomUUID()}`,
        role: "user",
        content: [{ type: "text", text: proposal.text }],
        source: { kind: OBSERVE_SOURCE_KIND },
      },
      commit: proposal.commit,
    };
  } catch (error) {
    log.error("[ctx-observe] pre-step suggestion skipped:", describeError(error));
    return null;
  }
}

/** 观测监听器的实例级依赖（对象化以便受 max-params 约束，同 SuggestionDeps 的理由）。 */
interface UsageObserverDeps {
  config: Config;
  log: Log;
  watchers: Map<string, UsageWatch>;
  toolCounts: Map<string, number>;
  watcherOf: (sessionId: string) => UsageWatch;
  applySettingsToWatcher: (watch: UsageWatch) => void;
  countOf: (sessionId: string) => number;
  pruneMaps: (keepId: string) => void;
}

// ── apply 的五个装配段（apply 只做编排，否则单个函数会长过
//    max-lines-per-function 上限）────────────────────────────────────────────

/**
 * 战略压缩建议：pre-step waterfall（around 中间件）——三段式：
 * ① computeSuggestion（自身 try/catch 吞错→null，建议绝不杀死回合）
 * ② downstream() 单次调用 ③ injectSuggestion 纯注入 + 注入成立才 commit 名额。
 * dsh 宿主已核实（agent-loop agent.ts:248-252）：默认 next 产出 enter
 * （[...claimed, context]）；下游监听器（model-selection /
 * session-checkpoint-policy）皆先 `const decision = await next()` 再改——
 * 本插件同契约，绝不丢弃下游消息。
 * 注册用 prepend（本监听在瀑布最外层）：① 这样注入看到的是全链合成后的决策，
 * 追加位置真的是消息末尾；② 两个审计探针必须注册在注入器之后（更内层），
 * 否则探针审的是注入后的裁决——审计 item 5 的掩码（enter-without-messages
 * 被伪装成干净的 msgsLen:1）。
 * downstream 只调一次的纪律：下游含 compaction-basic（每次调用都执行
 * compactIfNeeded——会话折叠，非幂等）与 session-checkpoint-policy（每次
 * 调用 sessions.flush）等有状态监听器；若在 catch 里重调 downstream 会造成
 * 二次压缩/二次 flush。downstream 自身抛错属宿主侧故障，如实上抛（与插件
 * 缺席时行为一致），绝不重入。
 */
function registerSuggestionInjector(svc: HostCtx, deps: SuggestionDeps, log: Log): void {
  svc.on(
    PRE_STEP_EVENT,
    async (payloadRaw: unknown, downstream: () => Promise<unknown>): Promise<unknown> => {
      const proposal = computeSuggestion(payloadRaw, deps, log);
      const decisionRaw = await downstream();
      if (proposal === null) {
        return decisionRaw;
      }
      const outcome = injectSuggestion(decisionRaw, proposal.message);
      if (outcome.injected) {
        // 审计 item 1：只有建议真的进了决策消息，才消费这次提醒名额。下游若
        // {kind:'reject'} 丢掉注入，名额留着——下一个 step 照常再提。
        proposal.commit();
      }
      return outcome.decision;
    },
    { prepend: true },
  );
}

/**
 * pre-step 形状探针：定位间歇性 turn/end kind:error（reading 'length'，code=UNKNOWN）——
 * 判别矩阵见 lib/prestep-audit.ts 头注释。双探夹逼：外层先注册（普通 on
 * 即 push 到链尾，后注册者更内层 → 本探针在另一探针之外），内层后注册。
 * 两者都刻意落在建议注入器之内：Cordis 的 waterfall 从 index 0 起算最外层
 * （vendor/cordis/src/events.ts register(): prepend→unshift / on→push；
 * waterfall(): cbs.shift() 依次向内），若探针用 prepend 就会跑到注入器之外、
 * 审到注入后的裁决，把畸形决策掩成干净形状。
 * 纪律：纯观察——只 await next() 并逐字 passthrough；落盘失败吞错不抛；
 * 进程生命周期条数上限防膨胀。
 */
function registerPreStepShapeProbes(svc: HostCtx): void {
  let auditRows = 0;
  const AUDIT_MAX_ROWS = 400;
  const auditObserver =
    (tag: string) =>
    async (payload: unknown, next: () => Promise<unknown>): Promise<unknown> => {
      // oxlint-disable-next-line node/callback-return -- waterfall next 为契约调用，结果需先经审计再透传
      const decision = await next();
      try {
        if (auditRows < AUDIT_MAX_ROWS) {
          for (const finding of findPreStepAnomalies(tag, payload, decision)) {
            auditRows += 1;
            appendShardLine(auditFile(), `${JSON.stringify({ ts: Date.now(), ...finding })}\n`);
            if (auditRows >= AUDIT_MAX_ROWS) {
              break;
            }
          }
        }
      } catch {
        // 观测绝不打断回合（落盘失败=静默丢条，与 appendMetric 纪律一致）
      }
      return decision;
    };
  svc.on(PRE_STEP_EVENT, auditObserver("outer"));
  svc.on(PRE_STEP_EVENT, auditObserver("inner"));
}

/** usage 观测：session/event 的 assistant/message（含 stream 回落）与
 *  assistant/attempt 计 usage；tool/call 计数；request/context 喂权威窗口。
 *  会话结束的另一条监听（session/disposed）同属这一族，收在同一装配段里。 */
function registerUsageObserver(svc: HostCtx, deps: UsageObserverDeps): void {
  svc.on("session/event", (sessionRaw: unknown, eventRaw: unknown) => {
    // 热路径只读 enabled 一位就早退（volatile 引用 .get() 现读）：关了就一个引用
    // 都不再多读，全量快照留给真正用到它的分支——这是本包最热的监听器，
    // 每个事件都要过这一关。
    if (!deps.config.enabled.get()) {
      return;
    }
    // P3：子代理会话不记账（不计数、不喂 watcher、不进 metrics）——压缩建议注入
    // 本就只对根会话（pre-step 的 isRootHeader），旧实现把子代理的 usage/tool/call
    // 混进同 id 会话的计数与指标，属数据噪声。根会话判定放最前，热路径零副作用。
    if (!sessionIsRoot(sessionRaw)) {
      return;
    }
    const event = eventPayloadOf(eventRaw);
    if (event === null || typeof event.type !== "string") {
      return;
    }
    // 会话标识：session 对象上有 id；取不到就记到 'default'
    const sessionId = fieldOf(sessionRaw, "id");
    const sid = typeof sessionId === "string" ? sessionId : "default";

    if (event.type === "tool/call") {
      deps.toolCounts.set(sid, deps.countOf(sid) + 1);
      // tool/call 也做容量纪律：极端会话（只调工具、无 assistant/message）不至于绕过淘汰。
      deps.pruneMaps(sid);
      return;
    }
    // 权威窗口：request/context 事件（agent-loop 每次请求写入 provider/model/contextWindow）
    if (event.type === "request/context") {
      const cw = event.data?.contextWindow;
      if (typeof cw === "number" && Number.isFinite(cw) && cw > 0) {
        // 同 computeSuggestion：接收者写上类，setWindow 的调用点才落在类型面上。
        // 这里不接下面那条 `watch`：watcherOf 会建实例，只有真拿到权威窗口时才该建。
        const windowed: UsageWatch = deps.watcherOf(sid);
        windowed.setWindow(cw);
      }
      return;
    }
    // 其余事件类型交给官方折叠口径判定：user/message、turn/* 等不带用量的事件
    // 在这里返回 null（tool/call 与 request/context 已在上面早退，不会走到）。
    const usage = usageOfEvent(event);
    if (usage === null) {
      return;
    }
    // 上下文占用量按官方 native pressure 口径 = input + cacheRead + cacheWrite
    // （usage-projection.ts:78-79 pressureFrom，明确不含 output——output 会成为下一次
    // 请求的 input，计入即重复计数、高产出回合会提前误报压力）。旧实现取 totalTokens
    // 优先且回退求和含 output，与此不符（量纲偏差）。仅当 inputTokens 缺失（个别 provider
    // 只报聚合 totalTokens）时才回退 totalTokens，避免旧档/异常 usage 直接归零。
    const tokens = pressureTokens(usage);
    // 接收者写上类（同 computeSuggestion 的口径）：window()/noteTokens 两条调用点都在这。
    const watch: UsageWatch = deps.watcherOf(sid);
    // 应用 settings：显式绝对阈值优先、清空即撤销；比例跟随窗口
    deps.applySettingsToWatcher(watch);
    // metrics 行只为 assistant/message 落：attempt 是"未落 surface 的废弃/重试
    // 结算"，写进每回合流水会把废弃尝试计成一回合（卡片 turns 虚增）；它的
    // usage 仍要喂 watcher（下面 noteTokens 同路）——官方折叠把它并入 totals 是
    // 因为那里算花费，这里记的是每回合最新上下文占用。metricsEnabled 现读单位：
    // 走到这里的都是 enabled 且带 usage 的事件，不值得为此读全量快照。
    if (deps.config.metricsEnabled.get() && event.type === "assistant/message") {
      appendMetric(
        {
          session: sid,
          turn: event.data?.turn,
          tokens,
          contextWindow: watch.window(),
          usage,
        },
        deps.log,
      );
    }
    // 只记录最新用量不消费提醒：提醒消费留给 pre-step 的 observe()——
    // 观测链调 observe() 会把首次提醒提前消费掉、注入点永远拿不到。
    watch.noteTokens(tokens);
    deps.pruneMaps(sid);
  });

  // 会话结束：真实 per-session 结束信号（core/session index.ts:62 'session/disposed'，
  // 与 session/event 同分发路径）。清 watcher 提醒状态 + 删两表条目（防泄漏，
  // 同 id 重建会话从干净状态起步）。
  svc.on("session/disposed", (sessionRaw: unknown) => {
    const sessionId = fieldOf(sessionRaw, "id");
    const sid = typeof sessionId === "string" ? sessionId : "default";
    // 接收者写上类：reset 的生产调用点就是这条回收路径（表里没有该会话时整段跳过）。
    const watch: UsageWatch | undefined = deps.watchers.get(sid);
    watch?.reset();
    deps.watchers.delete(sid);
    deps.toolCounts.delete(sid);
  });
}

/** 分片留存回收（每次启动一次）：单写者分片按 pid 散文件，不回收就是"每启动一个
 *  dsh 进程永久多一份"。判定见 planShardSweep 的安全性论证。 */
function registerShardRetentionSweep(
  svc: HostCtx,
  liveSettings: () => ResolvedSettings,
  log: Log,
): void {
  svc.effect(() => {
    // 不回收的前提只剩一个：metrics 关闭（关了就不再产生分片，用户要的是保留现状）。
    // 旧实现另外两条（读不到设置就不拿默认值猜、留存期非数就回落内置默认）在
    // 0.1.7 已无从触发：cordis 交进来的是按 Config schema 校验并填过默认值的引用
    // （`.natural().max(3650).default(30)`），读侧不再有失败路径，再留 try/catch 只会
    // 造出一个进不去的分支（本仓覆盖率锁 100%）。
    const cfg = liveSettings();
    if (!cfg.metricsEnabled) {
      return NOOP_DISPOSER;
    }
    const removed = sweepStaleShards(cfg.metricsRetentionDays, log);
    if (removed > 0) {
      log.info(`[ctx-observe] 回收 ${removed} 个过期的 metrics/audit 分片`);
    }
    return NOOP_DISPOSER;
  }, "ctx-observe: shard retention sweep");
}

/**
 * metrics 端点：必须对 webServer **建立依赖**，不能只在 apply 里读一次。
 * `ctx.get` 是无 inject 语义的存储读，官方注释本身就写着 "or `undefined` when not
 * (**yet**) provided"（installed @deepseek-ai/cordis/lib/types/reflect.d.ts:10-14）——
 * 真实宿主上 webServer 比本条目晚到位（隔离 DSH_HOME 实测：apply 当场 get 返回
 * undefined，+1.3s 才交得出服务），所以旧写法在任何 web profile 上都不注册本端点，
 * 还把这件正常事报成"宿主未提供 webServer"。子 fiber 只在依赖到位时激活、依赖换实例
 * 时先卸后装（同文件 registry.d.ts:97 "the callback is unloaded and re-run whenever a
 * required service changes"），effect 挂在子上下文上即得「后到即注册、重启即重注册」。
 * 不写进插件级 inject：那会让没有 webServer 的宿主（TUI）连观测一并失活。
 */
function registerMetricsEndpoint(svc: HostCtx, log: Log): void {
  svc.inject(["webServer"], (child) => {
    child.effect(() => {
      // 服务句柄直接由官方 `Context["get"]` 交出（`undefined | WebServer`，见 HostCtx 上那一位
      // 的注释），本地不再有 `Pick<WebServer, "register">` 投影，也不需要断言。
      // 这道闸现在挡的是**契约被打破**（inject 说到位却读不出），不再是正常缺席态。
      const webServer = svc.get("webServer");
      if (webServer === undefined) {
        log.error(
          "[ctx-observe] webServer 已注入却读不到服务实例，metrics 端点未注册：设置卡片与 context-budget 技能读不到用量数据",
        );
        return NOOP_DISPOSER;
      }
      // 路由字面量直接受官方 `WebRoute` 约束（installed
      // `@deepseek-ai/dsh-host-webserver/lib/types/index.d.ts:90`
      // `register(route: WebRoute): () => void`）：`kind` 因此是官方
      // `WebRouteKind = 'exact' | 'prefix'` 而不是自由字符串（写错 kind 只会表现为一条
      // 永不命中的路由，绑上去就提前到编译期），handler 的 (req, res) 形参亦由官方交出。
      // 非回环服务面只有这一个可读信号（`Config.host: '127.0.0.1' | '0.0.0.0'`，同一份 d.ts 的
      // `:50`/`:83`）：绑 0.0.0.0 时本机网卡持有的地址才算可信权威。
      const servingNonLoopback = webServer.host === "0.0.0.0";
      const route: WebRoute = {
        kind: "exact",
        path: METRICS_PATH,
        handler: (req, res) => {
          // 同源校验（F1 起交给 shared 的 trust 出口，本包那段 siteOf + 纯文本 403 一并收敛）：
          // 项目硬约束是所有插件端点须做 CORS 校验；GET 虽只读，但响应体是用量数据，
          // 被重绑定页面读到就是信息泄露，故照走三判据。
          if (!guardTrust(req, res, { servingNonLoopback })) {
            return;
          }
          // `?limit=`：缺席 = 全量（用户拍板"不为省 token 降能力"，默认不收窄）；
          // 正整数 = ts 升序后的尾部 N 行（最近 N 条，N 超行数时 slice 天然回落全量）。
          const rawLimit = queryParam(req, "limit");
          if (metricsLimitInvalid(rawLimit)) {
            res.writeHead(400, {
              "content-type": "text/plain; charset=utf-8",
              "cache-control": "no-store",
            });
            res.end("invalid ?limit= (positive integer expected)");
            return;
          }
          try {
            const rows = rawLimit === null ? readMetricsAll() : readMetricsLast(Number(rawLimit));
            res.writeHead(200, {
              "content-type": "text/plain; charset=utf-8",
              "cache-control": "no-store",
            });
            res.end(rows);
          } catch {
            res.writeHead(500);
            res.end("metrics read failed");
          }
        },
      };
      const dispose = webServer.register(route);
      // 两条出口都交回 disposer（官方 `Context["effect"]` 的工厂返回域不收 `undefined`，
      // 见上面 NOOP_DISPOSER 的注释）：契约被打破时是 NOOP_DISPOSER，注册成功时撤销路由。
      return () => {
        dispose();
      };
    }, "ctx-observe: metrics route");
  });
}

export function apply(ctx: Context, config: Config): void {
  // host 类型边界：从 cordis Context 收窄到本插件所需的服务句柄子集。
  // 属于第三方宿主能力解的固有写法（session-rescue/danger-guard 同款），此处无法
  // 再逐字段守卫投影——该子集全是方法（settings/effect/on/get）。
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- 本包 `on` 的放宽重载是必要的：`agent/pre-step` 不在本包编译程序的 `keyof Events` 里（实测 `const svc: HostCtx = ctx` 报 TS2322「string 不可赋给 keyof Events」），绑官方 `Context["on"]` 需先把 5 处监听器逐事件改写，属上方 deferred 决策，不是本条判据能就地满足的形状。
  const svc = ctx as unknown as HostCtx;

  // 具名 logger（官方 ctx.logger(name)）；宿主未装（异常 ctx/旧桩件）回退 console。
  const log: Log = svc.logger?.(PLUGIN_NAMESPACE) ?? console;

  // 实例级状态（apply 闭包内）：vitest 反复 apply 或宿主重建时干净起步。
  // 容量纪律：Map 超限按最旧淘汰（长驻进程防泄漏）。
  const watchers = new Map<string, UsageWatch>();
  const toolCounts = new Map<string, number>();

  // 0.1.7 起命名空间是**隐式**的：宿主把本条目导出的 Config 里标了 `.volatile()`
  // 的字段投影成设置表单，ns = profile 条目 id（`ctx-observe`）。插件侧不再注册，
  // 只声明页面策略：本包自带卡片，别让宿主再生成一份自动表单页。
  // owner 必须显式传本插件 fiber（缺省是 settings 服务自己的 fiber），且经
  // child.effect 挂载以便随注入子上下文回收——宿主 dsh-client-locale 同款写法。
  svc.inject(["settings"], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, svc.fiber));
  });

  // 建议正文的语言随官方 locale 偏好走：用户在「设置 → 常规」改语言后，下一次
  // pre-step 就是新文案（不重启、不加插件自己的 locale 设置项）。
  // 跨命名空间读在 0.1.7 只有 describe() 一条路（SettingsForms 的公开面没有 get(ns)），
  // 而它不廉价：对**每个**活跃条目做 schema.toJSON() + JSON.stringify 算 revision，再投影
  // value/base/user 三份（installed dsh-settings/lib/index.js:412-445）。本链挂在每个带
  // usage 的 session 事件与每次 pre-step 上（经 applySettingsToWatcher），故偏好读一次即
  // 缓存，靠宿主的推送式失效信号重读：写配置 → emit('app-boot/config-reload')
  // （installed dsh-app-boot/lib/index.js:3120）→ SettingsForms 监听它并 invalidate()
  // （dsh-settings/lib/index.js:336-338）→ 微任务里 describe()（:382-394）→ 对 raw 变化的
  // 条目 emit('settings/document-updated', ns, revision)（:434）。
  let cachedPreference: unknown = undefined;
  let hasCachedPreference = false;
  svc.on("settings/document-updated", (ns: unknown) => {
    if (ns === LOCALE_SETTINGS_NAMESPACE) {
      hasCachedPreference = false;
    }
  });

  /** locale 条目的偏好值；未投影出来 → undefined（中文默认）。**缺席不缓存**：locale
   *  条目可能晚于本条目才到位，缓存一次缺席就把语言跟随永久钉死成中文——与 metrics
   *  端点同一类「依赖迟到」陷阱，代价只是缺席时每事件多一次 describe()。
   *  单一返回点是刻意的：本仓 lint 的 consistent-return 配了 treatUndefinedAsUnspecified，
   *  `return undefined` 记作无值返回、与带值返回冲突。 */
  const localePreferenceOf = (): unknown => {
    if (!hasCachedPreference) {
      const row = svc.settings.describe().find((item) => item.ns === LOCALE_SETTINGS_NAMESPACE);
      if (row !== undefined) {
        cachedPreference = row.value;
        hasCachedPreference = true;
      }
    }
    return hasCachedPreference ? cachedPreference : undefined;
  };

  // 名字避开模块级的 messagesOf()（那个是从 unknown 决策里取 messages 数组）。
  const localeMessages = (): CtxObserveMessages =>
    messagesFor(MESSAGES, resolveLocalePreference(localePreferenceOf()));

  /** 现读一份解析后的设置（旧 scope.get() 的等价物）：每次调用都重新取引用的
   *  当前值，所以设置卡改完下一个事件/回合即生效。 */
  const liveSettings = (): ResolvedSettings => ({
    enabled: config.enabled.get(),
    suggestEnabled: config.suggestEnabled.get(),
    contextThresholdTokens: config.contextThresholdTokens.get(),
    contextRatio: config.contextRatio.get(),
    remindRatio: config.remindRatio.get(),
    metricsEnabled: config.metricsEnabled.get(),
    metricsRetentionDays: config.metricsRetentionDays.get(),
    remindIntervalTokens: config.remindIntervalTokens.get(),
    toolCountFirst: config.toolCountFirst.get(),
    toolCountInterval: config.toolCountInterval.get(),
    fallbackWindow: config.fallbackWindow,
  });

  // 阈值语义（v5 起）：不再猜 160k/200k（不同模型窗口不同，固定值是隐藏 bug 源）。
  // 权威 contextWindow 来自 dsh `request/context` 事件（agent-loop 每次请求写入）
  // 或 `session.requestContext()`；UsageWatch.setWindow 后按 窗口×contextRatio（默认 70%）
  // 触发。settings 显式 contextThresholdTokens 永远优先（UsageWatch.setThreshold）。
  const watcherOf = (sessionId: string): UsageWatch => {
    let watch = watchers.get(sessionId);
    if (watch === undefined) {
      const cfg = liveSettings();
      watch = new UsageWatch({
        ...(Number.isFinite(cfg.contextRatio) && cfg.contextRatio > 0
          ? { contextRatio: cfg.contextRatio }
          : {}),
        ...(Number.isFinite(cfg.remindRatio) && cfg.remindRatio > 0
          ? { remindRatio: cfg.remindRatio }
          : {}),
        remindIntervalTokens: cfg.remindIntervalTokens,
        toolCountFirst: cfg.toolCountFirst,
        toolCountInterval: cfg.toolCountInterval,
        fallbackWindow: cfg.fallbackWindow,
      });
      watchers.set(sessionId, watch);
    }
    return watch;
  };

  /** 应用 settings：显式绝对阈值永远优先于窗口比例；清空即撤销（item 6）。 */
  const applySettingsToWatcher = (watch: UsageWatch): void => {
    const cfg = liveSettings();
    watch.setRemindText(localeMessages().remindText);
    const explicit = Number(cfg.contextThresholdTokens);
    if (Number.isFinite(explicit) && explicit > 0) {
      watch.setThreshold(explicit);
    } else {
      // 用户在设置卡里清空了 contextThresholdTokens（值变 undefined/NaN）：
      // 没有这一步，旧绝对阈值会一直压着窗口比例直到会话销毁。
      watch.clearThreshold();
    }
    // 比例也要同步到已建 watcher（否则引用编辑只影响新会话）。
    watch.setRatios(
      Number.isFinite(cfg.contextRatio) ? cfg.contextRatio : undefined,
      Number.isFinite(cfg.remindRatio) ? cfg.remindRatio : undefined,
    );
  };

  /** 两张 Map 的统一容量纪律：超 200 个会话删最旧（长驻进程防膨胀）。 */
  const pruneMaps = (keepId: string): void => {
    const cap = 200;
    pruneToCapacity(watchers, keepId, cap);
    pruneToCapacity(toolCounts, keepId, cap);
  };
  const countOf = (sessionId: string): number => toolCounts.get(sessionId) ?? 0;

  const suggestionDeps: SuggestionDeps = {
    settingsOf: liveSettings,
    watcherFor: (sessionId: string): UsageWatch => {
      const watch = watcherOf(sessionId);
      applySettingsToWatcher(watch);
      pruneMaps(sessionId);
      return watch;
    },
    toolCountOf: countOf,
  };

  registerSuggestionInjector(svc, suggestionDeps, log);
  registerPreStepShapeProbes(svc);

  registerUsageObserver(svc, {
    config,
    log,
    watchers,
    toolCounts,
    watcherOf,
    applySettingsToWatcher,
    countOf,
    pruneMaps,
  });

  registerShardRetentionSweep(svc, liveSettings, log);
  registerMetricsEndpoint(svc, log);
}

export default {
  inject: ["settings"],
  Config: configSchema,
  apply,
};
