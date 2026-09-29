// host.ts 单元测试：usage 观测链（官方折叠口径）+ pre-step 建议注入（提案/提交
// 分离、下游认领保真、探针排序）+ 分片落盘与并发 + metrics 端点。
import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import plugin, { planShardSweep, pruneToCapacity, trimMetricsFile } from "../host.ts";
import {
  DEFAULT_INTERVAL,
  DEFAULT_TOOL_FIRST,
  DEFAULT_TOOL_INTERVAL,
  FALLBACK_WINDOW,
} from "../lib/usage-watch.ts";

// ── 事件名 / 端点 / 落盘名 fixture ──────────────────────────────────────
// 下面这些都是本文件自己构造入参、自己断言的**期望值**，故全部就地写字面值：
// 若从 host.ts 导入同一枚常量，断言就只是在和被测代码比同一个变量，测不出漂移。
/** usage 折叠口径的主来源事件（session/event 里的类型名）。 */
const ASSISTANT_MESSAGE_EVENT = "assistant/message";
/** 权威上下文窗口的来源事件。 */
const REQUEST_CONTEXT_EVENT = "request/context";
/** 建议注入器与两枚审计探针共同挂的那条 waterfall 事件。 */
const PRE_STEP_EVENT = "agent/pre-step";
/** metrics 端点路径（GET 聚合分片回读）。 */
const METRICS_ENDPOINT = "/_dsh/ctx-observe/metrics";
/** metrics 路由效应的标签：effectLabels 按标签取，避免与兄弟效应数量耦合。 */
const METRICS_ROUTE_LABEL = "ctx-observe: metrics route";
/** 本包的命名空间 id —— 缓存子目录 / 分片前缀 / 设置文档 id / patch 条目 id 共用它。 */
const PLUGIN_NAMESPACE = "ctx-observe";
/** pid 分片之前的旧单文件 metrics 落盘名（读侧兼容它）。 */
const LEGACY_METRICS_FILE = "ctx-observe.jsonl";
/** pre-step 审计的 finding 名：决策是 enter 却没带 messages。 */
const ENTER_WITHOUT_MESSAGES_FINDING = "enter-without-messages";
/** sec-fetch-site 的同源取值（信任闸门放行的两种之一）。 */
const SAME_ORIGIN_FETCH_SITE = "same-origin";

// ── 测试脚手架 ──────────────────────────────────────────────────────────
// 本文件创建的临时 DSH_HOME 目录统一登记，afterEach 显式回收。
// 旧实现依赖"系统清理 tmp 目录"——实测每次跑本套件泄漏 19 个目录，macOS 的 TMPDIR
// 清理按"30 天未访问"判定并不激进，已累积 1100 个残留。改为显式 rmSync。
const scratchRoots: string[] = [];

/** 建临时目录并登记回收。 */
function mkScratch(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  scratchRoots.push(root);
  return root;
}

/** 临时改环境变量，跑完精确复原（原本未设置的键复原为 delete 而非 "undefined"）。 */
function withEnv(overrides: Record<string, string | undefined>, body: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
  try {
    body();
  } finally {
    for (const key of Object.keys(saved)) {
      const value = saved[key];
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  }
}

const logged = { errors: [] as unknown[][], warns: [] as unknown[][], infos: [] as unknown[][] };
const originalError = console.error;
const originalWarn = console.warn;
const originalInfo = console.info;

/** 最近一次 createHost 的 logger 记录入口（loggedText 兼读 mock logger 与 console）。 */
let activeMockForLogs: HostMock | null = null;

/** 把捕获到的 console 调用 + mock logger 记录拼成可断言的文本（多参按空格连接）。
 *  W4 后 host 日志走 ctx.logger(name) 具名 facade（mock.logCalls），console 捕获
 *  只接 noLogger 回退分支——两路都进同一条断言通道。 */
function loggedText(): string {
  const loggerLines = (activeMockForLogs?.logCalls ?? [])
    .filter((call) => call.type === "error" || call.type === "warn")
    .map((call) => call.args.map(String).join(" "));
  const consoleLines = [...logged.errors, ...logged.warns].map((args) =>
    args.map(String).join(" "),
  );
  return [...loggerLines, ...consoleLines].join("\n");
}

type Listener = (...args: unknown[]) => unknown;

/** 本插件注入的建议消息形状（host 侧 SuggestionMessage 的测试镜像）。
 *  source 只有 producer-owned kind：0.1.7 起 `{ kind: 'plugin', plugin }` 包装
 *  被 V4 准入拒收，身份串是 `plugin:ctx-observe`。 */
interface SuggestionLike {
  id: string;
  role: "user";
  content: { type: "text"; text: string }[];
  source: { kind: "plugin:ctx-observe" };
}
type PreStepFn = (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>;

interface Registration {
  event: string;
  prepend: boolean;
}

/** 一次 settings.configure() 的调用记录（页面策略断言用）。 */
interface ConfigureCall {
  presentation: { auto?: boolean };
  owner: unknown;
}

interface HostMock {
  /** 设置卡当前值：volatile 引用背后的可变宿主，改它即等价于"用户改了设置"。 */
  value: Record<string, unknown>;
  /** 本插件 fiber 的替身：configure 的 owner 必须原样带回它（身份断言用）。 */
  fiber: unknown;
  /** settings.configure 的调用记录（页面策略断言用）。 */
  configureCalls: ConfigureCall[];
  registrations: Registration[];
  handlers: Record<string, Listener[]>;
  routes: Map<string, Listener>;
  /**
   * 已登记的 effect 工厂。**返回域按官方形状收成 `() => void`**：官方
   * `Context['effect']` 的 `SyncEffect`/`Effect` 两支都不受理 `undefined`
   *（installed cordis/lib/types/fiber.d.ts:49-50），本包生产侧因此一律交回 disposer，
   * 夹具再声明「可能没有返回值」就是在替一条不存在的形状开后门（并逼测试写
   * `if (cleanup !== undefined)` 那种永不成立的分支，撞本仓 100% 分支门）。
   */
  effectFactories: (() => () => void)[];
  /** effect 标签（与 effectFactories 同序）：按标签取效应，别再用"总共几个"当判据。 */
  effectLabels: (string | undefined)[];
  /** 各 effect 工厂交回的 disposer（与 effectFactories 同序）：断言"服务离场即撤销路由"。 */
  effectDisposers: (() => void)[];
  /** settings.describe() 被调了几次：locale 偏好的缓存命中率只能用它来钉。 */
  describeCalls: number;
  /** locale 条目当前的投影值（可中途改，等价于用户在「设置 → 常规」换语言）。 */
  locale: { preference?: string } | undefined;
  /** ctx.logger(name) 交出的具名 logger 落下的每条消息（name/type/args）。 */
  logCalls: { name: string; type: string; args: unknown[] }[];
  /** 让迟到的 webServer 到位：翻转服务可用性并激活被推迟的那个 inject 子 fiber。 */
  attachWebServer: () => void;
}

interface HostOptions {
  webServer?: boolean;
  /** true → `inject(["webServer"])` 先不回调（复刻真实宿主里 webServer 晚于本条目到位），
   *  由 `mock.attachWebServer()` 才激活。锁的是"注册时机"而不是"注册发生过"。 */
  deferWebServer?: boolean;
  /** settings.describe() 抛出的异常（Error 与非 Error 都要测到）；缺省 = 不抛。
   *  0.1.7 里插件侧唯一会失败的宿主调用就是 describe()（跨命名空间读 locale）：
   *  配置值本身是 cordis 解析好的引用，取一个已冻结的快照不存在"读不到"这条路径，
   *  旧 mock 让 scope.get() 抛的那个入口已经不存在了。 */
  throws?: unknown;
  /** settings.get("locale") 的返回值（官方 locale 插件的解析值）；缺省 = 未注册。 */
  locale?: { preference?: string };
  /** true → 桩件不提供 ctx.logger（异常 ctx 形态）：host 回退 console 的兼容分支要被覆盖。 */
  noLogger?: boolean;
}

const DEFAULT_VALUE: Record<string, unknown> = {
  enabled: true,
  suggestEnabled: true,
  contextThresholdTokens: undefined,
  contextRatio: 0.7,
  remindRatio: 0.05,
  metricsEnabled: false,
};

/** 导出 Config schema 的字段名清单（单源：不手写，漏字段就是测试的事）。 */
const CONFIG_KEYS: string[] = Object.keys(
  (plugin.Config as unknown as { dict: Record<string, unknown> }).dict,
);

/**
 * 复刻 cordis 交进 apply 的那份 Config：每个 volatile 字段一枚**稳定引用**，
 * 其 get() 现读 mock.value —— 与真实 Volatile 的"引用不变、值可变"同构
 * （cosmokit createVolatile 也只有一个 get()，见 vendor/cosmokit/src/volatile.ts:39-45）。
 */
function liveConfigRefs(read: (key: string) => unknown): Record<string, { get: () => unknown }> {
  return Object.fromEntries(CONFIG_KEYS.map((key) => [key, { get: () => read(key) }]));
}

/** Config schema 的字段节点（读 meta/type/dict 用，不复制 schema 结构）。 */
interface SchemaNode {
  type?: string;
  meta?: Record<string, unknown>;
  dict?: Record<string, SchemaNode>;
}

/** 导出 Config schema 的 dict（单源：字段名与元数据都从宿主实际读的那份来）。 */
function configDict(): Record<string, SchemaNode> {
  return (plugin.Config as unknown as SchemaNode).dict ?? {};
}

/** 逐字段 schema 默认 —— 等价于 0.1.6 交给 `settings.register(ns, schema, { base })`
 *  的那份底座，0.1.7 把它搬到了 schema 的 `.default()` 上（少一层「底座」）。 */
function schemaDefaults(): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(configDict()).map(([key, field]) => [key, field.meta?.["default"]]),
  );
}

/**
 * 复刻宿主 packages/settings/settings/src/schema.ts:37-47 的 volatileForm()：
 * 「自身标了 volatile」或「是 object 且子树里有可编辑字段」的字段才进表单。
 * @returns 顶层 object 时给表单字段名清单；叶子可编辑时给 []；
 *  null = 该子树没有任何可编辑字段 → 宿主 describe() 会整条跳过本条目
 *  （settings/src/index.ts:308-309），写入则抛 `has no volatile fields`（:386）。
 *  （用 null 而不是 undefined 表"没有"：本仓 lint 的 consistent-return 配了
 *  `treatUndefinedAsUnspecified`，`return undefined` 记作无值返回、与 `return []` 冲突。）
 */
function volatileFormOf(node: SchemaNode): string[] | null {
  if (node.meta?.["volatile"] === true) {
    return [];
  }
  if (node.type !== "object") {
    return null;
  }
  const kept = Object.entries(node.dict ?? {}).flatMap(([key, child]) =>
    volatileFormOf(child) === null ? [] : [key],
  );
  return kept.length === 0 ? null : kept;
}

/** cordis.patch.yml 里的裸条目 id —— 0.1.7 的 settings 命名空间就是它。
 *  读文件而不是抄常量：卡片/端点/命名空间三处都按它对齐，写死会让测试与包体漂移。 */
function patchEntryId(): string {
  const yml = readFileSync(fileURLToPath(new URL("../cordis.patch.yml", import.meta.url)), "utf8");
  const match = /^\s*-\s+id:\s*(?<id>\S+)\s*$/mu.exec(yml);
  const id = match?.groups?.["id"];
  assert.ok(typeof id === "string" && id.length > 0, "cordis.patch.yml 里没有裸 `- id:` 条目");
  return id;
}

/**
 * 造一个最小宿主 mock 并 apply。
 *
 * on() 复刻 cordis events.register 的排序（prepend→unshift / 普通 on→push），
 * 数组下标即瀑布"由外向内"的执行序——审计 item 5 的"探针必须落在注入器之内"
 * 契约靠它验证，否则 mock 与真实宿主语义不同、测试会假绿。
 */
function createHost(
  value: Record<string, unknown> = DEFAULT_VALUE,
  options: HostOptions = {},
): HostMock {
  /** 本插件 fiber 的替身：configure 的 owner 必须原样带回它（断言用）。 */
  const fiber = { id: "ctx-observe-fiber" };
  // 真实宿主上 webServer 晚于本条目到位（本轮隔离 DSH_HOME 实测 +1.3s），所以服务可用性
  // 是可变位而不是定值：deferWebServer 下要等 mock.attachWebServer() 才交得出实例。
  let webServerAvailable = options.deferWebServer !== true && options.webServer !== false;
  /** 被推迟的那次 inject 的激活口；null = 没有待激活的子 fiber。闭包在 ctx 体内构造，
   *  故这里不前向引用 ctx（attach 拿到的 child 就是 ctx 本身）。 */
  let pendingWebServer: (() => void) | null = null;
  const mock: HostMock = {
    value,
    fiber,
    configureCalls: [],
    registrations: [],
    handlers: {},
    routes: new Map(),
    effectFactories: [],
    effectLabels: [],
    effectDisposers: [],
    describeCalls: 0,
    locale: options.locale,
    logCalls: [],
    // 只在 apply 之后被调用，故此处调的是已构造完的激活闭包。
    attachWebServer: () => {
      webServerAvailable = true;
      pendingWebServer?.();
      pendingWebServer = null;
    },
  };
  activeMockForLogs = mock;
  const ctx = {
    fiber,
    logger:
      options.noLogger === true
        ? undefined
        : (name: string) => ({
            info: (...args: unknown[]): void => {
              mock.logCalls.push({ name, type: "info", args });
            },
            warn: (...args: unknown[]): void => {
              mock.logCalls.push({ name, type: "warn", args });
            },
            error: (...args: unknown[]): void => {
              mock.logCalls.push({ name, type: "error", args });
            },
          }),
    settings: {
      /** 页面策略登记：宿主用它决定要不要自动生成表单页。 */
      configure: (presentation: { auto?: boolean }, owner?: unknown) => {
        mock.configureCalls.push({ presentation, owner });
        return (): void => {
          void 0;
        };
      },
      /** 跨命名空间读的官方入口：本包只用它取 locale.preference（文案语言）。
       *  读 mock.locale（可中途改）并计数——locale 缓存命中与否只能靠调用次数钉。 */
      describe: () => {
        mock.describeCalls += 1;
        if (options.throws !== undefined) {
          // oxlint-disable-next-line typescript/only-throw-error -- 替身按用例注入任意抛出值（串与 Object.create(null) 都要能抛，见 host.test 的 throws 三例），包成 new Error 就测不到热路径 catch 对非 Error 的降级摘要
          throw options.throws;
        }
        return mock.locale === undefined ? [] : [{ ns: "locale", value: mock.locale as unknown }];
      },
    },
    /** ctx.inject(deps, fn)：cordis 用带齐依赖的子上下文回调；deps 未到位时**不回调**，
     *  到位才激活（deferWebServer 复刻的正是这一段，见 mock.attachWebServer）。 */
    inject: (deps: readonly string[], attach: (child: unknown) => void) => {
      if (deps.includes("webServer") && options.deferWebServer === true) {
        pendingWebServer = (): void => {
          attach(ctx);
        };
        return;
      }
      attach(ctx);
    },
    on: (event: string, handler: Listener, opts?: { prepend?: boolean }) => {
      mock.registrations.push({ event, prepend: opts?.prepend === true });
      const existing = mock.handlers[event] ?? [];
      mock.handlers[event] = existing;
      if (opts?.prepend === true) {
        existing.unshift(handler);
      } else {
        existing.push(handler);
      }
    },
    effect: (factory: () => () => void, label?: string) => {
      mock.effectFactories.push(factory);
      mock.effectLabels.push(label);
      mock.effectDisposers.push(factory());
    },
    get: (name: string): unknown => {
      let result: unknown;
      if (name === "webServer" && webServerAvailable) {
        result = {
          register: (route: { kind: string; path: string; handler: Listener }) => {
            mock.routes.set(route.path, route.handler);
            return (): void => {
              mock.routes.delete(route.path);
            };
          },
        };
      }
      return result;
    },
  };
  plugin.apply(ctx as never, liveConfigRefs((key) => mock.value[key]) as never);
  return mock;
}

/**
 * 本包在 dsh 数据目录下的落盘子目录：`<home>/cache/ctx-observe`。
 *
 * 为什么是 cache 而不是 metrics：dsh 承认的数据目录只有 sessions/ storages/
 * cache/ logs/，`cache/` 的语义正是「可丢弃的派生数据」——每回合 token 流水
 * 属离线分析输入，删了不丢任何事实（真源在 session 事件流里）。自制目录名
 * 等于给用户的数据目录里私搭违建，发布出去就是各家一套。
 * 表达式与 host.ts 的 `dshHomePath("cache", CACHE_SUBDIR)` 同源（DSH_HOME 优先、
 * 空白视为未设、否则 `~/.dsh`，全部由 @deepseek-ai/dsh-home-paths 决定）。
 */
function cacheShardDir(home: string): string {
  return path.join(home, "cache", PLUGIN_NAMESPACE);
}

/** 分片文件名（item 7：单写者分片，文件名带 pid）。 */
function metricsPath(dir: string): string {
  return path.join(cacheShardDir(dir), `ctx-observe.${String(process.pid)}.jsonl`);
}

function auditPath(dir: string): string {
  return path.join(cacheShardDir(dir), `pre-step-audit.${String(process.pid)}.jsonl`);
}

/** 读一个文件的全部非空行（文件不存在 → 空数组）。 */
function linesOf(file: string): string[] {
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

/** 打 session/event（走宿主同一条分发路径：本进程注册的全部监听）。 */
function emit(mock: HostMock, session: unknown, event: unknown): void {
  for (const handler of mock.handlers["session/event"] ?? []) {
    handler(session, event);
  }
}

/**
 * 打 settings/document-updated(ns, revision)：宿主的**推送式**失效信号。
 * 链路（installed dsh-settings/lib/index.js）：写配置 → emit('app-boot/config-reload')
 * （:336-338 监听）→ invalidate() → 微任务里 describe()（:382-394）→ 对 raw 变化的条目
 * emit 本事件（:434）。本包只借最后一跳来作废 locale 偏好的缓存。
 */
function emitDocumentUpdated(mock: HostMock, ns: string): void {
  for (const handler of mock.handlers["settings/document-updated"] ?? []) {
    handler(ns, 1);
  }
}

/** 取决策末尾那条建议的正文字符串（语言断言看的就是它）。 */
function tailText(decision: unknown): string {
  return JSON.stringify((decision as { messages: unknown[] }).messages.at(-1));
}

/** 真实 Session 形状的最小 mock：id/header/requestContext 由 harness 保证存在。 */
function rootSession(id: unknown, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, header: { cwd: "/w" }, requestContext: (): undefined => undefined, ...over };
}

function payloadFor(sid: unknown, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { agent: { session: rootSession(sid, over) }, turn: 2, step: 1, messages: [] };
}

/** pre-step 链上第 index 个监听（0 = 建议注入器，1/2 = outer/inner 探针）。 */
function chainAt(mock: HostMock, index: number): PreStepFn {
  const listener = (mock.handlers[PRE_STEP_EVENT] ?? [])[index] as PreStepFn | undefined;
  assert.ok(listener !== undefined, "agent/pre-step 监听已注册");
  return listener;
}

/** 走建议注入器（链上最外层 = index 0）。 */
async function inject(
  mock: HostMock,
  payload: unknown,
  next: () => Promise<unknown>,
): Promise<unknown> {
  return chainAt(mock, 0)(payload, next);
}

/** 根生产者的默认决策（harness 默认形状：enter + messages）。 */
async function enterEmpty(): Promise<unknown> {
  return { kind: "enter", messages: [] };
}

/**
 * 灌一条超阈值的 usage 后走一遍注入器，返回合成决策。
 * 文案语言断言（zh / en）要看的就是这条决策的末条消息，两个用例只差 mock 的 locale。
 */
async function heavyUsageSuggestion(mock: HostMock, sid: string): Promise<unknown> {
  emit(
    mock,
    { id: sid },
    {
      type: ASSISTANT_MESSAGE_EVENT,
      data: {
        turn: 1,
        usage: {
          inputTokens: 90_000,
          outputTokens: 20_000,
          cacheReadTokens: 0,
          totalTokens: 110_000,
        },
      },
    },
  );
  return inject(mock, payloadFor(sid), async () => ({ kind: "enter", messages: [{ id: "m1" }] }));
}

/** 注入后的消息条数（无注入 = 原决策的 messages 长度；非数组 → -1）。 */
function messageCount(decision: unknown): number {
  let count = -1;
  if (decision !== null && typeof decision === "object") {
    const { messages } = decision as { messages?: unknown };
    if (Array.isArray(messages)) {
      count = messages.length;
    }
  }
  return count;
}

/** 再走一遍 pre-step 链，返回注入后的消息条数。 */
async function askAt(mock: HostMock, sid: string): Promise<number> {
  const payload = payloadFor(sid);
  return messageCount(await inject(mock, payload, enterEmpty));
}

/** 本进程 metrics 分片的行（JSON 解析后）。 */
function metricRows(dir: string): Record<string, unknown>[] {
  const file = metricsPath(dir);
  return linesOf(file).map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** 单个子进程报告的落盘分片名。 */
function metricShards(dir: string): string[] {
  return readdirSync(cacheShardDir(dir)).filter((name) => /^ctx-observe\.\d+\.jsonl$/u.test(name));
}

interface ChildReport {
  code: number | null;
  stderr: string;
}

/** 子进程内跑真实 host 事件链的脚本：走 session/event 洪流写 rows 行 metrics。
 *  session id 故意做长（~900 字符），让 9000 行就足够越过 5MB 保险丝。
 *  脚本正文是**子进程的源码文本**，里面的 `"assistant/message"` / `"session/event"` 是写进
 *  字符串的字面量，不是本文件那几枚常量的引用（替换成标识符会让子进程 ReferenceError）。 */
function writerScript(rows: number): string {
  const hostTs = fileURLToPath(new URL("../host.ts", import.meta.url));
  return `
import { pathToFileURL } from "node:url";
const mod = await import(pathToFileURL(${JSON.stringify(hostTs)}).href);
const value = { enabled: true, suggestEnabled: false, contextThresholdTokens: undefined,
  contextRatio: 0.7, remindRatio: 0.05, metricsEnabled: true, metricsRetentionDays: 30,
  remindIntervalTokens: 60000, toolCountFirst: 50, toolCountInterval: 25, fallbackWindow: 128000 };
const live = Object.fromEntries(Object.entries(value).map(([k, v]) =>
  [k, k === "fallbackWindow" ? v : { get: () => v }]));

const handlers = {};
mod.apply({
  fiber: {},
  // describe() 空数组 = 官方 locale 插件未注册该命名空间（中文默认）。
  settings: { configure: () => () => {}, describe: () => [] },
  inject: (_deps, callback) => callback({ settings: { configure: () => () => {} }, effect: (f) => f() }),
  on: (event, handler) => { (handlers[event] ??= []).push(handler); },
  effect: () => undefined,
  get: () => undefined,
}, live);
const sid = "spawn-" + String(process.pid) + "-" + "x".repeat(900);
for (let turn = 0; turn < ${String(rows)}; turn += 1) {
  handlers["session/event"][0]({ id: sid },
    { type: "assistant/message", data: { turn, usage: { inputTokens: 1000 + turn } } });
}
`;
}

/** 并行起 count 个子进程，各自走 session/event 洪流写 rows 行 metrics。 */
async function spawnMetricWriters(
  count: number,
  rows: number,
  dir: string,
): Promise<ChildReport[]> {
  const pending = Array.from({ length: count }, () => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", writerScript(rows)], {
      env: { ...process.env, DSH_HOME: dir },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const settled = Promise.withResolvers<ChildReport>();
    child.on("exit", (code) => {
      settled.resolve({ code, stderr });
    });
    return settled.promise;
  });
  return Promise.all(pending);
}

// ── 瀑布注册序与探针掩码的两个生产者（审计 item 5 / item 4）──────────────
// 留在模块作用域：包进套件里就成了「不捕获父作用域变量的嵌套函数」，纯函数该待在最外层。
async function malformedProducer(): Promise<unknown> {
  return { kind: "enter" };
}

async function claimedProducer(): Promise<unknown> {
  return { kind: "enter", messages: [{ id: "c" }] };
}

// 全部套件包一层 describe：console 捕获复位与临时目录回收是**文件级**钩子
// （beforeEach / afterEach），而 vitest(require-top-level-describe) 要求钩子待在
// describe 里。钩子的作用域正是「所在 describe 及其全部子套件」，所以包在最外面
// 这一层，逐例语义与原先写在文件根上完全一致。
describe("ctx-observe host", () => {
  beforeEach(() => {
    logged.errors = [];
    logged.warns = [];
    logged.infos = [];
    console.error = (...args: unknown[]) => {
      logged.errors.push(args);
    };
    console.warn = (...args: unknown[]) => {
      logged.warns.push(args);
    };
    console.info = (...args: unknown[]) => {
      logged.infos.push(args);
    };
  });

  afterEach(() => {
    console.error = originalError;
    console.warn = originalWarn;
    console.info = originalInfo;
    while (scratchRoots.length > 0) {
      rmSync(scratchRoots.pop()!, { recursive: true, force: true });
    }
  });

  // ── 基础接线 ─────────────────────────────────────────────────────────────
  describe("ctx-observe host 接线", () => {
    let dir: string;
    let mock: HostMock;

    beforeEach(() => {
      dir = mkScratch("ctx-obs-");
      process.env["DSH_HOME"] = dir;
      mock = createHost({ ...DEFAULT_VALUE, metricsEnabled: true });
    });

    it("隐式注册：Config schema 逐字段默认 = 0.1.6 交给 register 的内置底座", () => {
      // 0.1.7 删了 settings.register(ns, schema, { base })：命名空间 = profile 条目 id，
      // 默认值改由 schema 自己带（cordis 装载期用同一份 schema 填默认，fiber.ts resolveConfig）。
      // 所以"底座"这层断言原样搬到这里，逐字段对齐，少一个默认就会在真实宿主上变样。
      assert.deepEqual(schemaDefaults(), {
        enabled: true,
        suggestEnabled: true,
        // v5：绝对阈值**不给**默认（undefined → 窗口比例生效，v5 隐藏 bug 根因）
        contextThresholdTokens: undefined,
        contextRatio: 0.7,
        remindRatio: 0.05,
        metricsEnabled: true,
        metricsRetentionDays: 30,
        // W4：提醒节奏三旋钮（volatile 上卡）+ 兜底假定窗（非 volatile 部署值）。
        // 默认与 lib/usage-watch 单源（同枚导出常量），schema 与 lib 不再各写一份。
        remindIntervalTokens: DEFAULT_INTERVAL,
        toolCountFirst: DEFAULT_TOOL_FIRST,
        toolCountInterval: DEFAULT_TOOL_INTERVAL,
        fallbackWindow: FALLBACK_WINDOW,
      });
    });

    it("toolCountFirst 下调后辅信号（无 usage）按工具计数提前提请", async () => {
      // 默认 toolCountFirst=50：两次 tool/call 后 tokens 未知，辅信号未达线 → 无建议。
      // 调成 2 后同型两连击即达首提醒线 → pre-step 出现建议块。旋钮经 Config 一路
      // 传进 UsageWatch（watcherOf 透传），这条断言把整条链钉住。
      const custom = createHost({
        ...DEFAULT_VALUE,
        metricsEnabled: true,
        toolCountFirst: 2,
        toolCountInterval: 3,
        remindIntervalTokens: 5000,
        fallbackWindow: 64_000,
      });
      const session = { id: "s-knobs" };
      emit(custom, session, { type: "tool/call" });
      emit(custom, session, { type: "tool/call" });
      const decision = await inject(custom, payloadFor("s-knobs"), async () => ({
        kind: "enter",
        messages: [{ id: "m1" }],
      }));
      assert.equal(messageCount(decision), 2, "原消息 + 辅信号建议块（默认要 50 次才到）");
      // 对照组：默认阈值的 host 同型两连击保持沉默。
      const decision2 = await inject(mock, payloadFor("s-knobs"), async () => ({
        kind: "enter",
        messages: [{ id: "m1" }],
      }));
      assert.equal(messageCount(decision2), 1, "默认 toolCountFirst=50 时 2 次调用不提醒");
    });

    it("页面策略：settings.configure({ auto: false }) 恰好一次且 owner 是本插件 fiber", () => {
      // owner 缺省是 settings 服务自己的 fiber —— 传错就等于给别人的页面定了策略。
      assert.equal(mock.configureCalls.length, 1, "本包应只登记一次页面策略");
      assert.deepEqual(mock.configureCalls[0]?.presentation, { auto: false });
      assert.equal(mock.configureCalls[0].owner, mock.fiber);
    });

    it("宿主未装 logger（noLogger）→ console 回退路径仍留痕", () => {
      // webServer:false + noLogger：契约点名的 log.error 走 `?? console` 回退，
      // 而全局 console 已被 beforeEach 换成捕获器 ⇒ logged.errors 应有那条点名。
      const bare = createHost(
        { ...DEFAULT_VALUE, metricsEnabled: true },
        { noLogger: true, webServer: false },
      );
      assert.equal(bare.routes.size, 0, "读不到 webServer 不注册路由");
      assert.match(loggedText(), /metrics 端点未注册/u, "console 回退分支同样出声");
    });

    it("metrics 端点已注册", () => {
      assert.ok(mock.routes.has(METRICS_ENDPOINT));
    });

    it("usage 超阈值 → pre-step 返回带建议块的 enter 决策", async () => {
      emit(
        mock,
        { id: "s1" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: {
            turn: 1,
            usage: {
              inputTokens: 90_000,
              outputTokens: 20_000,
              cacheReadTokens: 0,
              totalTokens: 110_000,
            },
          },
        },
      );
      const payload = payloadFor("s1");
      const decision = await inject(mock, payload, async () => ({
        kind: "enter",
        messages: [{ id: "m1" }],
      }));
      assert.equal(messageCount(decision), 2, "原消息 + 建议块");
      const tail = JSON.stringify((decision as { messages: unknown[] }).messages.at(-1));
      assert.match(tail, /ctx-observe|压缩/u);
    });

    it("官方 locale 偏好为 en 时，注入的建议是英文文案", async () => {
      mock = createHost(
        { ...DEFAULT_VALUE, metricsEnabled: true },
        { locale: { preference: "en-US" } },
      );
      const decision = await heavyUsageSuggestion(mock, "s-en");
      const tail = JSON.stringify((decision as { messages: unknown[] }).messages.at(-1));
      assert.match(tail, /checkpoint/u, "英文建议正文");
      assert.doesNotMatch(tail, /压缩/u, "不该混进中文");
    });

    it("locale 命名空间未注册（无官方 locale 插件）→ 中文默认，不抛", async () => {
      mock = createHost({ ...DEFAULT_VALUE, metricsEnabled: true });
      const decision = await heavyUsageSuggestion(mock, "s-zh");
      const tail = JSON.stringify((decision as { messages: unknown[] }).messages.at(-1));
      assert.match(tail, /压缩/u);
    });

    it("locale 偏好读一次即缓存：后续回合不再全量 describe()", async () => {
      mock = createHost(
        { ...DEFAULT_VALUE, metricsEnabled: true },
        { locale: { preference: "en-US" } },
      );
      await heavyUsageSuggestion(mock, "cache-1");
      const afterFirst = mock.describeCalls;
      assert.ok(afterFirst > 0, "首回合至少读过一次偏好");
      const second = await heavyUsageSuggestion(mock, "cache-2");
      assert.equal(mock.describeCalls, afterFirst, "命中缓存后不该再投影全部条目");
      assert.match(tailText(second), /checkpoint/u, "缓存不能把语言读丢");
    });

    it("改语言 + 收到 locale 的失效信号 → 下一回合即新文案（README 的不重启承诺）", async () => {
      mock = createHost({ ...DEFAULT_VALUE, metricsEnabled: true });
      assert.match(tailText(await heavyUsageSuggestion(mock, "live-1")), /压缩/u);
      mock.locale = { preference: "en-US" };
      emitDocumentUpdated(mock, "locale");
      assert.match(tailText(await heavyUsageSuggestion(mock, "live-2")), /checkpoint/u);
    });

    it("非 locale 条目的失效信号不该打穿缓存", async () => {
      mock = createHost(
        { ...DEFAULT_VALUE, metricsEnabled: true },
        { locale: { preference: "en-US" } },
      );
      await heavyUsageSuggestion(mock, "other-1");
      const afterFirst = mock.describeCalls;
      emitDocumentUpdated(mock, PLUGIN_NAMESPACE);
      await heavyUsageSuggestion(mock, "other-2");
      assert.equal(mock.describeCalls, afterFirst, "别的条目变更与本包的偏好读无关");
    });

    it("偏好缺席不缓存：locale 条目迟到到位后仍会切语言", async () => {
      // 与 metrics 端点同一类「依赖迟到」：把缺席当值缓存下去，语言跟随就永久钉死在中文。
      mock = createHost({ ...DEFAULT_VALUE, metricsEnabled: true });
      assert.match(tailText(await heavyUsageSuggestion(mock, "late-1")), /压缩/u);
      const afterMiss = mock.describeCalls;
      await heavyUsageSuggestion(mock, "late-2");
      assert.ok(mock.describeCalls > afterMiss, "缺席不落缓存，下一回合仍重读");
      mock.locale = { preference: "en-US" };
      emitDocumentUpdated(mock, "locale");
      assert.match(tailText(await heavyUsageSuggestion(mock, "late-3")), /checkpoint/u);
    });

    it("usage 未超阈值 → 直接透传 next() 决策（同一引用）", async () => {
      emit(
        mock,
        { id: "s2" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: { turn: 1, usage: { totalTokens: 1000 } },
        },
      );
      const decision = { kind: "enter", messages: [] };
      const out = await inject(mock, payloadFor("s2"), async () => decision);
      assert.ok(out === decision, "未注入时逐字透传下游对象");
    });

    it("子代理会话不注入建议", async () => {
      emit(
        mock,
        { id: "s3" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: { turn: 1, usage: { totalTokens: 999_999 } },
        },
      );
      const decision = { kind: "enter", messages: [] };
      const payload = payloadFor("s3", { header: { cwd: "/w", delegationDepth: 1 } });
      const out = await inject(mock, payload, async () => decision);
      assert.ok(out === decision, "子代理决策原样透传");
    });

    it("metrics 分片落在 cache/ctx-observe 子目录（文件名带 pid）", () => {
      emit(
        mock,
        { id: "s4" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: { turn: 1, usage: { totalTokens: 42 } },
        },
      );
      assert.ok(existsSync(metricsPath(dir)), "本进程分片已落盘");
      const rows = metricRows(dir);
      assert.equal(rows.at(-1)?.["tokens"], 42);
      assert.equal(rows.at(-1)?.["session"], "s4");
      // metrics/ 不是 dsh 承认的数据目录（sessions/ storages/ cache/ logs/）：
      // 迁移后一律不该再出现，否则用户数据目录里又躺着一个各家自建的孤儿目录。
      assert.ok(!existsSync(path.join(dir, "metrics")), "不再写自制的 metrics/ 目录");
    });

    it("子代理会话不记账（metrics 无子代理行）", () => {
      const sub = { id: "s-sub", header: { cwd: "/w", delegationDepth: 1, origin: "subagent" } };
      emit(mock, sub, {
        type: ASSISTANT_MESSAGE_EVENT,
        data: { turn: 1, usage: { totalTokens: 999 } },
      });
      assert.ok(!existsSync(metricsPath(dir)), "子代理 usage 不写 metrics（根会话才记账）");
    });

    it("DSH_HOME 空白（官方口径视为未设）→ 落 HOME/.dsh/cache/ctx-observe 且热路径不抛", () => {
      // 旧用例名："DSH_HOME/HOME 均未设置 → 只日志不抛"。自制解析在那种态下会
      // 抛错，热路径靠 catch 兜住；改用 @deepseek-ai/dsh-home-paths 后解析是**全函数**
      // （永远有 OS home 兜底），"抛错"这条路不复存在。意图原样保留但换个不碰
      // 真实家目录的等价触发态：DSH_HOME 为空白串（home-paths 按未设处理）+
      // HOME 指向 scratch，断言热路径既不抛、也不往自制目录里写。
      withEnv({ DSH_HOME: "   ", HOME: dir }, () => {
        const bare = createHost({ ...DEFAULT_VALUE, metricsEnabled: true });
        assert.doesNotThrow(() => {
          emit(
            bare,
            { id: "s-noenv" },
            {
              type: ASSISTANT_MESSAGE_EVENT,
              data: { turn: 1, usage: { totalTokens: 1 } },
            },
          );
        });
        // 兜底根 = `~/.dsh`，这里 HOME 指向 scratch，所以是 `<scratch>/.dsh`。
        const fallbackHome = path.join(dir, ".dsh");
        assert.ok(
          existsSync(metricsPath(fallbackHome)),
          "空白 DSH_HOME 视为未设 → HOME 兜底的 cache 子目录",
        );
        assert.equal(loggedText(), "", "解析成功就不该有任何降级日志");
      });
    });
  });

  describe("pre-step 监听注册序与探针掩码", () => {
    let dir: string;

    beforeEach(() => {
      dir = mkScratch("ctx-obs-order-");
      process.env["DSH_HOME"] = dir;
    });

    it("注入器 prepend 注册为最外层，两个探针随后注册（更内层、不用 prepend）", () => {
      const mock = createHost();
      const registrations = mock.registrations.filter((item) => item.event === PRE_STEP_EVENT);
      assert.deepEqual(registrations, [
        { event: PRE_STEP_EVENT, prepend: true },
        { event: PRE_STEP_EVENT, prepend: false },
        { event: PRE_STEP_EVENT, prepend: false },
      ]);
      // cordis 序：prepend→unshift 到 index 0（最外层）、普通 on→push（依次向内）
      assert.equal(mock.handlers[PRE_STEP_EVENT]?.length, 3);
    });

    it("嵌套跑完整链：探针看到的是注入前的裁决，畸形决策不被建议掩掉", async () => {
      const mock = createHost({ ...DEFAULT_VALUE, contextThresholdTokens: 100 });
      emit(
        mock,
        { id: "mask" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: { turn: 1, usage: { totalTokens: 200 } },
        },
      );
      const payload = payloadFor("mask");
      const outer = chainAt(mock, 1);
      const inner = chainAt(mock, 2);
      // 根生产者产出 enter 但缺 messages（正是探针要找的崩溃指纹）
      const composed = await inject(mock, payload, () =>
        outer(payload, () => inner(payload, malformedProducer)),
      );
      // 注入器按 item 4 的判据不接管缺 messages 的畸形决策 → 原样透传
      assert.deepEqual(composed, { kind: "enter" });
      const file = auditPath(dir);
      const findings = linesOf(file).map((line) => JSON.parse(line) as Record<string, unknown>);
      const kinds = findings.map((row) => row["finding"]);
      assert.deepEqual(kinds, [ENTER_WITHOUT_MESSAGES_FINDING, ENTER_WITHOUT_MESSAGES_FINDING]);
      assert.deepEqual(
        findings.map((row) => row["tag"]),
        ["inner", "outer"],
        "内层探针先结算先落行、外层探针后落行（两探针都在注入器之内）",
      );
    });

    it("正常 enter：注入器追加建议，探针不误报", async () => {
      const mock = createHost({ ...DEFAULT_VALUE, contextThresholdTokens: 100 });
      emit(
        mock,
        { id: "clean" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: { turn: 1, usage: { totalTokens: 200 } },
        },
      );
      const payload = payloadFor("clean");
      const outer = chainAt(mock, 1);
      const inner = chainAt(mock, 2);
      const composed = await inject(mock, payload, () =>
        outer(payload, () => inner(payload, claimedProducer)),
      );
      assert.equal(messageCount(composed), 2, "建议追加在链尾");
      assert.equal(linesOf(auditPath(dir)).length, 0, "干净形状零审计行");
    });
  });

  // ── 官方 usage 折叠（审计 item 3）───────────────────────────────────────
  describe("usage 折叠：data.usage → stream 回落 → assistant/attempt", () => {
    let dir: string;
    let mock: HostMock;

    beforeEach(() => {
      dir = mkScratch("ctx-obs-fold-");
      process.env["DSH_HOME"] = dir;
      mock = createHost({ ...DEFAULT_VALUE, metricsEnabled: true });
    });

    it("inputTokens 存在时按 native pressure（input+cacheRead+cacheWrite，不含 output）", () => {
      emit(
        mock,
        { id: "u1" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: {
            turn: 1,
            usage: {
              inputTokens: 1000,
              outputTokens: 200,
              cacheReadTokens: 300,
              cacheWriteTokens: 400,
            },
          },
        },
      );
      assert.equal(metricRows(dir).at(-1)?.["tokens"], 1700);
    });

    it("assistant/message 无 data.usage：usage 在 stream 最后一个 usage chunk → 指标不缺口", () => {
      emit(
        mock,
        { id: "u2" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: {
            turn: 1,
            stream: [
              { type: "chunk", chunk: { type: "text", text: "hi" } },
              {
                type: "chunk",
                chunk: { type: "usage", usage: { inputTokens: 500, outputTokens: 7 } },
              },
            ],
          },
        },
      );
      const tokens = metricRows(dir).map((row) => row["tokens"]);
      assert.deepEqual(tokens, [500], "stream 回落生效（旧实现此处静默丢指标）");
    });

    it("stream 有多个 usage chunk 时取最后一个（对齐 lastAssistantStreamChunk 倒序首命中）", () => {
      emit(
        mock,
        { id: "u3" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: {
            stream: [
              { type: "chunk", chunk: { type: "usage", usage: { inputTokens: 100 } } },
              { type: "chunk", chunk: { type: "usage", usage: { inputTokens: 300 } } },
            ],
          },
        },
      );
      assert.equal(metricRows(dir).at(-1)?.["tokens"], 300);
    });

    it("stream 无可读 usage（非数组 / 无 chunk / chunk.usage 非对象）→ 不落盘不抛", () => {
      emit(mock, { id: "u4" }, { type: ASSISTANT_MESSAGE_EVENT, data: { stream: "oops" } });
      emit(
        mock,
        { id: "u4" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: { stream: [{ type: "text-chunks" }] },
        },
      );
      emit(
        mock,
        { id: "u4" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: { stream: [{ type: "chunk", chunk: { type: "usage", usage: "nope" } }] },
        },
      );
      assert.equal(metricRows(dir).length, 0);
    });

    it("assistant/attempt 的 stream usage 喂 watcher（建议链成立）但不写每回合流水", async () => {
      const attempt = createHost({
        ...DEFAULT_VALUE,
        contextThresholdTokens: 100,
        metricsEnabled: true,
      });
      emit(
        attempt,
        { id: "a1" },
        {
          type: "assistant/attempt",
          data: {
            turn: 1,
            stream: [{ type: "chunk", chunk: { type: "usage", usage: { inputTokens: 500 } } }],
          },
        },
      );
      assert.equal(metricRows(dir).length, 0, "attempt 不进每回合流水");
      const out = await inject(attempt, payloadFor("a1"), claimedProducer);
      assert.equal(messageCount(out), 2, "attempt 的 usage 已喂 watcher → 阈值判定成立");
    });

    it("既无 data.usage 也无 stream 的 assistant/message → 跳过", () => {
      emit(mock, { id: "u5" }, { type: ASSISTANT_MESSAGE_EVENT, data: { turn: 1 } });
      assert.equal(metricRows(dir).length, 0);
    });
  });

  // ── 注入语义（审计 item 1 / 2 / 4）──────────────────────────────────────
  describe("pre-step 注入：不伪造、不偷吃名额、兜底支路可达", () => {
    let dir: string;

    beforeEach(() => {
      dir = mkScratch("ctx-obs-inject-");
      process.env["DSH_HOME"] = dir;
    });

    it("下游 reject 丢掉注入 → 提醒名额未消费，下一 step 照常再提", async () => {
      const mock = createHost({ ...DEFAULT_VALUE, contextThresholdTokens: 100 });
      emit(
        mock,
        { id: "r1" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: { turn: 1, usage: { totalTokens: 200 } },
        },
      );
      const rejection = { kind: "reject", reason: "nope" };
      const rejected = await inject(mock, payloadFor("r1"), async () => rejection);
      assert.ok(rejected === rejection, "reject 原样透传");
      // 旧实现此刻已把 lastRemindAt 写成 200 → 下一 step 永远拿不到建议，
      // 要再涨一个间隔才会再提。
      assert.equal(await askAt(mock, "r1"), 1, "未注入不消费名额 → 同水位仍提醒");
    });

    it("下游返回非对象（undefined / 字符串）→ 原样透传，绝不伪造 enter（item 4）", async () => {
      const mock = createHost({ ...DEFAULT_VALUE, contextThresholdTokens: 100 });
      emit(
        mock,
        { id: "f1" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: { turn: 1, usage: { totalTokens: 200 } },
        },
      );
      const payload = payloadFor("f1");
      const voided = await inject(mock, payload, async (): Promise<unknown> => undefined);
      assert.equal(voided, undefined, "非对象决策透传（伪造会把该 step 已认领的消息丢掉）");
      const probe = await inject(mock, payload, async () => "oops");
      assert.equal(probe, "oops");
      assert.equal(await askAt(mock, "f1"), 1, "非对象决策同样不消费名额");
    });

    it("enter 缺 messages（畸形）→ 透传不接管，且名额未消费", async () => {
      const mock = createHost({ ...DEFAULT_VALUE, contextThresholdTokens: 100 });
      emit(
        mock,
        { id: "f2" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: { turn: 1, usage: { totalTokens: 200 } },
        },
      );
      const malformed = { kind: "enter" };
      const payload = payloadFor("f2");
      assert.ok((await inject(mock, payload, async () => malformed)) === malformed);
      const out = await inject(mock, payload, claimedProducer);
      const ids = (out as { messages: { id?: string }[] }).messages.map((message) => message.id);
      assert.equal(ids.length, 2, "畸形决策不消费名额 → 下一次仍注入");
      assert.equal(ids[0], "c", "下游认领保序在前");
      assert.match(String(ids[1]), /^ctx-observe-/u);
    });

    it("messages 非数组（对象/字符串/数字）→ 透传不接管", async () => {
      const mock = createHost({ ...DEFAULT_VALUE, contextThresholdTokens: 100 });
      emit(
        mock,
        { id: "f3" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: { turn: 1, usage: { totalTokens: 200 } },
        },
      );
      const payload = payloadFor("f3");
      const badDecisions = [{}, "messages", 7].map((bad) => ({ kind: "enter", messages: bad }));
      const passthrough = await Promise.all(
        badDecisions.map(async (decision): Promise<unknown> =>
          inject(mock, payload, async () => decision),
        ),
      );
      assert.deepEqual(
        passthrough.map((out, index) => out === badDecisions[index]),
        [true, true, true],
        "messages 非数组的决策一律原样透传",
      );
      assert.equal(await askAt(mock, "f3"), 1, "畸形决策不吃名额");
    });

    it("下游认领的 user messages 与 startsRequestSeries 全量保留", async () => {
      const mock = createHost({ ...DEFAULT_VALUE, contextThresholdTokens: 100 });
      emit(
        mock,
        { id: "k1" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: { turn: 1, usage: { totalTokens: 200 } },
        },
      );
      const out = await inject(mock, payloadFor("k1"), async () => ({
        kind: "enter",
        messages: [{ id: "claimed-a" }, { id: "claimed-b" }],
        startsRequestSeries: true,
      }));
      const { messages, startsRequestSeries, kind } = out as {
        kind: string;
        messages: { id: string }[];
        startsRequestSeries?: boolean;
      };
      assert.equal(kind, "enter");
      assert.equal(startsRequestSeries, true, "spread 保留下游声明");
      assert.deepEqual(
        messages.map((message) => message.id),
        ["claimed-a", "claimed-b", messages[2]?.id],
      );
      assert.equal(messages.length, 3);
    });

    it("建议块形状契约（id/role/content/source）", async () => {
      const mock = createHost({ ...DEFAULT_VALUE, contextThresholdTokens: 100 });
      emit(
        mock,
        { id: "shape" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: { turn: 1, usage: { totalTokens: 200 } },
        },
      );
      const out = await inject(mock, payloadFor("shape"), enterEmpty);
      const [suggestion] = (out as { messages: SuggestionLike[] }).messages;
      assert.match(suggestion?.id ?? "", /^ctx-observe-/u);
      assert.equal(suggestion?.role, "user");
      const [firstContent] = suggestion.content;
      assert.equal(firstContent?.type, "text");
      assert.match(firstContent.text, /压缩/u);
      assert.deepEqual(suggestion.source, { kind: "plugin:ctx-observe" });
    });

    it("注入 source 必须是 producer-owned kind（不得回退到 'plugin'）", async () => {
      // 0.1.7 的 V4 准入（session-format-v3-to-v4/src/message-sources.ts）对每个
      // 声明的持久消息位拒收退役包装 `{ kind: 'plugin', plugin }`，抛
      // "format v4 message requires a producer-owned source kind"：宿主在首个 attempt
      // 里把 pre-step 决策的 messages 逐条 append 成 `user/message`
      // （core/agent-loop/src/agent.ts:401-404），正是被拒的持久位——一条这样的
      // 建议就会把整个会话的落盘拒绝掉。
      const mock = createHost({ ...DEFAULT_VALUE, contextThresholdTokens: 100 });
      emit(
        mock,
        { id: "producer-kind" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: { turn: 1, usage: { totalTokens: 200 } },
        },
      );
      const out = await inject(mock, payloadFor("producer-kind"), enterEmpty);
      const [suggestion] = (out as { messages: { source: Record<string, unknown> }[] }).messages;
      assert.ok(suggestion !== undefined, "阈值已过 → 建议必须落在 messages 里");
      assert.notEqual(suggestion.source["kind"], "plugin");
      assert.equal(suggestion.source["kind"], "plugin:ctx-observe", "须是本插件的 producer 串");
      assert.equal(suggestion.source["plugin"], undefined, "退役包装的 plugin 字段不得再出现");
    });

    it("从未观测的会话 + 50 次 tool/call → 辅信号支路可达（item 2）", async () => {
      const mock = createHost({ ...DEFAULT_VALUE, metricsEnabled: true });
      for (let tool = 0; tool < 50; tool += 1) {
        emit(mock, { id: "never" }, { type: "tool/call", data: { name: "read" } });
      }
      // 无 session/event 建过 watcher：旧实现这里 watchers.get()===undefined 直接早退
      const out = await inject(mock, payloadFor("never"), enterEmpty);
      assert.equal(messageCount(out), 1, "watcherOf 兜底建表 → toolCountFirst 辅信号生效");
      assert.ok(!existsSync(metricsPath(dir)), "tool/call 不落 metrics");
    });

    it("next() 的 enter（含下游 sysmsg）+ 到期提醒 → 同时保留 sysmsg 与建议块", async () => {
      const mock = createHost({ ...DEFAULT_VALUE, contextThresholdTokens: 5000 });
      emit(
        mock,
        { id: "a1" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: { turn: 1, usage: { totalTokens: 6000 } },
        },
      );
      const sysmsg = { id: "sys-downstream", role: "system", content: "assembled context" };
      const out = await inject(mock, payloadFor("a1"), async () => ({
        kind: "enter",
        messages: [sysmsg],
      }));
      const { kind, messages } = out as { kind: string; messages: { id?: string }[] };
      assert.equal(kind, "enter");
      assert.ok(
        messages.some((message) => message.id === "sys-downstream"),
        "保留下游 sysmsg",
      );
      assert.match(JSON.stringify(messages.at(-1)), /ctx-observe|压缩/u, "建议块仍在末尾");
    });

    it("enabled=false / suggestEnabled=false → 观测与注入各自停摆", async () => {
      const off = createHost({ ...DEFAULT_VALUE, enabled: false, metricsEnabled: true });
      emit(
        off,
        { id: "e1" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: { turn: 1, usage: { totalTokens: 9 } },
        },
      );
      assert.equal(metricRows(dir).length, 0, "enabled=false 不落盘");
      const decision = { kind: "enter", messages: [{ id: "x" }] };
      const passthrough = await inject(off, payloadFor("e1"), async () => decision);
      assert.ok(passthrough === decision, "enabled=false pre-step 原样透传");

      const noSuggest = createHost({
        ...DEFAULT_VALUE,
        suggestEnabled: false,
        contextThresholdTokens: 1,
        metricsEnabled: true,
      });
      emit(
        noSuggest,
        { id: "e2" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: { turn: 1, usage: { totalTokens: 999 } },
        },
      );
      assert.equal(metricRows(dir).length, 1, "suggestEnabled=false 仍观测");
      const out = await inject(noSuggest, payloadFor("e2"), async () => decision);
      assert.ok(out === decision, "suggestEnabled=false 不注入");
    });

    it("载荷不合真实 Session 形状 → 透传（缺 requestContext / id 非串 / header 非对象）", async () => {
      const mock = createHost({ ...DEFAULT_VALUE, contextThresholdTokens: 1 });
      emit(
        mock,
        { id: "shape2" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: { turn: 1, usage: { totalTokens: 999 } },
        },
      );
      const decision = { kind: "enter", messages: [{ id: "m" }] };
      const sessionless = { agent: { session: { id: "shape2", header: { cwd: "/w" } } }, turn: 1 };
      const cases: unknown[] = [
        sessionless,
        payloadFor(42),
        payloadFor("shape2", { header: "oops" }),
        payloadFor("shape2", { requestContext: "not-a-fn" }),
        { agent: null },
        undefined,
        "not-an-object",
      ];
      const results = await Promise.all(
        cases.map(async (payload: unknown): Promise<unknown> =>
          inject(mock, payload, async () => decision),
        ),
      );
      assert.deepEqual(
        results.map((out) => out === decision),
        cases.map(() => true),
        "全部原样透传",
      );
    });

    // 0.1.7 里建议链上唯一还能抛的宿主调用面是 settings.describe()（跨命名空间读 locale）：
    // 配置值本身是 cordis 解析好的引用，取一个冻结快照不存在失败路径。旧用例的
    // `scope.get 抛错` 换到这里，验证的不变式一条没减——任何抛错都不许打断热路径，
    // 且 downstream 只调一次（catch 里重调 = 二次压缩/二次 flush）。
    it("settings.describe() 抛错 → downstream 恰好一次、决策同一引用透传", async () => {
      const mock = createHost(DEFAULT_VALUE, { throws: new Error("describe-boom") });
      const decision = { kind: "enter", messages: [{ id: "m" }] };
      let nextCalls = 0;
      const out = await inject(mock, payloadFor("boom"), async () => {
        nextCalls += 1;
        return decision;
      });
      assert.equal(nextCalls, 1, "downstream 只调一次（catch 里重调 = 二次压缩/flush）");
      assert.ok(out === decision);
      assert.match(loggedText(), /pre-step suggestion skipped: describe-boom/u);
    });

    it("建议链抛出非 Error（字符串 / 无原型对象）→ 摘要降级、回合不被杀死", async () => {
      const decision = { kind: "enter", messages: [{ id: "m" }] };
      const stringy = createHost(DEFAULT_VALUE, { throws: "boom-string" });
      const outStringy = await inject(stringy, payloadFor("err1"), async () => decision);
      assert.ok(outStringy === decision);
      assert.match(loggedText(), /pre-step suggestion skipped: boom-string/u);

      const exotic = createHost(DEFAULT_VALUE, { throws: Object.create(null) });
      const outExotic = await inject(exotic, payloadFor("err2"), async () => decision);
      assert.ok(outExotic === decision);
      assert.match(
        loggedText(),
        /pre-step suggestion skipped: unstringifiable error/u,
        "连 String() 都抛的异常也不能打断热路径",
      );
    });

    it("比例设置非法（缺省 / 0）→ watcher 与 setRatios 各自忽略，保持内置 70%/5%", async () => {
      // 两路都要验：缺省（NaN）走 host 的 isFinite 守卫，0 走 UsageWatch 的区间守卫
      const configs: Record<string, unknown>[] = [
        { contextRatio: undefined, remindRatio: undefined },
        { contextRatio: 0, remindRatio: 0 },
      ];
      const counts = await Promise.all(
        configs.map(async (ratios: Record<string, unknown>): Promise<number> => {
          const mock = createHost({
            enabled: true,
            suggestEnabled: true,
            contextThresholdTokens: undefined,
            metricsEnabled: false,
            ...ratios,
          });
          emit(
            mock,
            { id: "ratio" },
            {
              type: REQUEST_CONTEXT_EVENT,
              data: { contextWindow: 1_000_000 },
            },
          );
          emit(
            mock,
            { id: "ratio" },
            {
              type: ASSISTANT_MESSAGE_EVENT,
              data: { turn: 1, usage: { totalTokens: 700_000 } },
            },
          );
          return askAt(mock, "ratio");
        }),
      );
      assert.deepEqual(counts, [1, 1], "非法比例被忽略，仍按默认 70%/5% 触发");
    });

    it("不带用量的事件类型（user/message、turn/start、空 attempt）→ 观测链静默跳过", () => {
      const mock = createHost({ ...DEFAULT_VALUE, metricsEnabled: true });
      emit(mock, { id: "quiet" }, { type: "user/message", data: { turn: 1, message: "hi" } });
      emit(mock, { id: "quiet" }, { type: "turn/start", data: { turn: 1 } });
      emit(mock, { id: "quiet" }, { type: "assistant/attempt", data: { turn: 1 } });
      assert.equal(metricRows(dir).length, 0);
    });

    it("downstream 自身抛错 → 如实上抛且绝不重入", async () => {
      const mock = createHost({ ...DEFAULT_VALUE, contextThresholdTokens: 100 });
      emit(
        mock,
        { id: "throw" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: { turn: 1, usage: { totalTokens: 200 } },
        },
      );
      let nextCalls = 0;
      const boom = async (): Promise<unknown> => {
        nextCalls += 1;
        throw new Error("downstream-boom");
      };
      await assert.rejects(inject(mock, payloadFor("throw"), boom), /downstream-boom/u);
      assert.equal(nextCalls, 1);
    });
  });

  // ── 窗口比例阈值（v5）与阈值清空（item 6）───────────────────────────────
  describe("窗口比例触发与阈值清空", () => {
    let dir: string;

    beforeEach(() => {
      dir = mkScratch("ctx-obs-window-");
      process.env["DSH_HOME"] = dir;
    });

    it("request/context 1M 窗口：699_999 不提醒，700_000（70%）提醒", async () => {
      const mock = createHost();
      emit(mock, { id: "w1" }, { type: REQUEST_CONTEXT_EVENT, data: { contextWindow: 1_000_000 } });
      emit(
        mock,
        { id: "w1" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: { turn: 1, usage: { totalTokens: 699_999 } },
        },
      );
      assert.equal(await askAt(mock, "w1"), 0, "699_999 < 700k 不该提醒");
      emit(
        mock,
        { id: "w1" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: { turn: 3, usage: { totalTokens: 700_000 } },
        },
      );
      assert.equal(await askAt(mock, "w1"), 1, "700k = 1M×70% 应提醒");
    });

    it("1M 窗口：提醒后 30k 增量（<50k 间隔）不重复，50k 增量再提醒", async () => {
      const mock = createHost();
      emit(mock, { id: "w2" }, { type: REQUEST_CONTEXT_EVENT, data: { contextWindow: 1_000_000 } });
      emit(
        mock,
        { id: "w2" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: { turn: 1, usage: { totalTokens: 700_000 } },
        },
      );
      assert.equal(await askAt(mock, "w2"), 1, "首过 700k 提醒一次");
      emit(
        mock,
        { id: "w2" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: { turn: 4, usage: { totalTokens: 730_000 } },
        },
      );
      assert.equal(await askAt(mock, "w2"), 0, "730k 距 700k 仅 30k < 50k 间隔");
      emit(
        mock,
        { id: "w2" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: { turn: 5, usage: { totalTokens: 750_000 } },
        },
      );
      assert.equal(await askAt(mock, "w2"), 1, "750k 距 700k 50k，再提醒");
    });

    it("128k 小窗：89_600（70%）提醒——固定 160k 在此窗口永不触发", async () => {
      const mock = createHost();
      emit(mock, { id: "w3" }, { type: REQUEST_CONTEXT_EVENT, data: { contextWindow: 128_000 } });
      emit(
        mock,
        { id: "w3" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: { turn: 1, usage: { totalTokens: 89_600 } },
        },
      );
      assert.equal(await askAt(mock, "w3"), 1);
    });

    it("settings 显式绝对阈值 → 窗口比例让位；清空后立刻回到窗口比例（item 6）", async () => {
      const value: Record<string, unknown> = { ...DEFAULT_VALUE, contextThresholdTokens: 900_000 };
      const mock = createHost(value);
      emit(mock, { id: "w4" }, { type: REQUEST_CONTEXT_EVENT, data: { contextWindow: 1_000_000 } });
      emit(
        mock,
        { id: "w4" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: { turn: 1, usage: { totalTokens: 700_000 } },
        },
      );
      assert.equal(await askAt(mock, "w4"), 0, "900k 配置阈值下 700k 不该提醒（虽已超 70%）");
      // 用户在设置卡里清空绝对阈值（运行时值退化为 undefined）
      value["contextThresholdTokens"] = undefined;
      assert.equal(await askAt(mock, "w4"), 1, "清空后必须立即回到 1M×70%=700k 口径");
    });

    it("scope 比例编辑同步到已建 watcher", async () => {
      const value: Record<string, unknown> = { ...DEFAULT_VALUE, contextRatio: 0.7 };
      const mock = createHost(value);
      emit(
        mock,
        { id: "a3h" },
        { type: REQUEST_CONTEXT_EVENT, data: { contextWindow: 1_000_000 } },
      );
      emit(
        mock,
        { id: "a3h" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: { turn: 1, usage: { totalTokens: 500_000 } },
        },
      );
      assert.equal(await askAt(mock, "a3h"), 0, "0.7 下 500k 不提醒");
      value["contextRatio"] = 0.5;
      emit(
        mock,
        { id: "a3h" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: { turn: 3, usage: { totalTokens: 500_000 } },
        },
      );
      assert.equal(await askAt(mock, "a3h"), 1, "改 0.5 后 500k 应提醒");
    });

    it("无 request/context 事件：回落兜底阈值 89_600（170k 提醒）", async () => {
      const mock = createHost();
      emit(
        mock,
        { id: "w5" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: { turn: 1, usage: { totalTokens: 170_000 } },
        },
      );
      assert.equal(await askAt(mock, "w5"), 1);
    });

    it("事件缺席时 pre-step 从 session.requestContext() 兜底读权威窗口", async () => {
      const mock = createHost();
      emit(
        mock,
        { id: "w6" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: { turn: 1, usage: { totalTokens: 750_000 } },
        },
      );
      const payload = payloadFor("w6", {
        requestContext: () => ({ provider: "p", model: "m", contextWindow: 1_000_000 }),
      });
      const out = await inject(mock, payload, enterEmpty);
      assert.equal(messageCount(out), 1, "750k > 1M×70% → 兜底窗口生效");
    });

    it("requestContext 返回无效窗口（字符串 / undefined）→ 忽略并回落兜底阈值", async () => {
      const bad = createHost();
      emit(
        bad,
        { id: "w8" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: { turn: 1, usage: { totalTokens: 90_000 } },
        },
      );
      const badPayload = payloadFor("w8", { requestContext: () => ({ contextWindow: "oops" }) });
      assert.equal(messageCount(await inject(bad, badPayload, enterEmpty)), 1, "90_000 > 89_600");

      const nothing = createHost();
      emit(
        nothing,
        { id: "w9" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: { turn: 1, usage: { totalTokens: 80_000 } },
        },
      );
      const quietPayload = payloadFor("w9");
      assert.equal(
        messageCount(await inject(nothing, quietPayload, enterEmpty)),
        0,
        "兜底阈值下不提醒",
      );
    });

    it("无效窗口（NaN/0/字符串/缺字段）不设窗口，回落 89_600 兜底", async () => {
      const mock = createHost();
      emit(
        mock,
        { id: "cw1" },
        { type: REQUEST_CONTEXT_EVENT, data: { contextWindow: Number.NaN } },
      );
      emit(mock, { id: "cw1" }, { type: REQUEST_CONTEXT_EVENT, data: { contextWindow: 0 } });
      emit(mock, { id: "cw1" }, { type: REQUEST_CONTEXT_EVENT, data: { contextWindow: "100000" } });
      emit(mock, { id: "cw1" }, { type: REQUEST_CONTEXT_EVENT, data: {} });
      emit(
        mock,
        { id: "cw1" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: { turn: 1, usage: { totalTokens: 89_599 } },
        },
      );
      assert.equal(await askAt(mock, "cw1"), 0, "89_599 < 89_600 兜底阈值不提醒");
      emit(
        mock,
        { id: "cw1" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: { turn: 3, usage: { totalTokens: 89_600 } },
        },
      );
      assert.equal(await askAt(mock, "cw1"), 1, "89_600 达到兜底阈值提醒");
    });

    it("metrics 行带 contextWindow 字段（窗口已知时）", () => {
      const mock = createHost({ ...DEFAULT_VALUE, metricsEnabled: true });
      emit(mock, { id: "w7" }, { type: REQUEST_CONTEXT_EVENT, data: { contextWindow: 128_000 } });
      emit(
        mock,
        { id: "w7" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: { turn: 1, usage: { totalTokens: 42 } },
        },
      );
      const rows = metricRows(dir);
      assert.equal(rows.at(-1)?.["tokens"], 42);
      assert.equal(rows.at(-1)?.["contextWindow"], 128_000, "metrics 记录权威窗口");
    });
  });

  // ── tool/call 辅信号与 session/disposed ─────────────────────────────────
  describe("tool/call 计数与 dispose", () => {
    it("49 次不提醒；dispose 清零后重新累计；dispose 无 id / null 不抛", async () => {
      const dir = mkScratch("ctx-obs-tool-");
      process.env["DSH_HOME"] = dir;
      const mock = createHost();
      emit(mock, { id: "t2" }, { type: REQUEST_CONTEXT_EVENT, data: { contextWindow: 1_000_000 } });
      for (let tool = 0; tool < 49; tool += 1) {
        emit(mock, { id: "t2" }, { type: "tool/call", data: {} });
      }
      assert.equal(await askAt(mock, "t2"), 0, "49 次不足首次提醒");
      const disposed = mock.handlers["session/disposed"] ?? [];
      assert.ok(disposed.length > 0, "订阅 session/disposed");
      disposed[0]?.({ id: "t2" });
      disposed[0]?.({});
      disposed[0]?.(null);
      emit(mock, { id: "t2" }, { type: REQUEST_CONTEXT_EVENT, data: { contextWindow: 1_000_000 } });
      for (let tool = 0; tool < 49; tool += 1) {
        emit(mock, { id: "t2" }, { type: "tool/call", data: {} });
      }
      assert.equal(await askAt(mock, "t2"), 0, "dispose 清零后 49 次仍不足（未从旧计数继续累计）");
      for (let tool = 0; tool < 2; tool += 1) {
        emit(mock, { id: "t2" }, { type: "tool/call", data: {} });
      }
      assert.equal(await askAt(mock, "t2"), 1, "dispose 后累计 51 次触发辅信号");
    });

    it("dispose 后同会话同用量重新提醒（lastRemindAt 已清）", async () => {
      const dir = mkScratch("ctx-obs-dispose-");
      process.env["DSH_HOME"] = dir;
      const mock = createHost({ ...DEFAULT_VALUE, contextThresholdTokens: 1000 });
      emit(
        mock,
        { id: "a6" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: { turn: 1, usage: { totalTokens: 1000 } },
        },
      );
      assert.equal(await askAt(mock, "a6"), 1, "首过阈值提醒");
      assert.equal(await askAt(mock, "a6"), 0, "同水位不重复");
      for (const handler of mock.handlers["session/disposed"] ?? []) {
        handler({ id: "a6" });
      }
      emit(
        mock,
        { id: "a6" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: { turn: 1, usage: { totalTokens: 1000 } },
        },
      );
      assert.equal(await askAt(mock, "a6"), 1, "dispose 后同条件重新提醒");
    });

    it("突发 250 会话：容量剪枝不影响逐条落盘", () => {
      const dir = mkScratch("ctx-obs-prune-");
      process.env["DSH_HOME"] = dir;
      const mock = createHost({ ...DEFAULT_VALUE, metricsEnabled: true });
      for (let session = 0; session < 250; session += 1) {
        emit(
          mock,
          { id: `burst-${String(session)}` },
          {
            type: ASSISTANT_MESSAGE_EVENT,
            data: { turn: 1, usage: { totalTokens: 5 } },
          },
        );
      }
      assert.equal(metricRows(dir).length, 250, "每条 usage 都落一行流水");
    });
  });

  // ── 分片落盘与并发（审计 item 7）────────────────────────────────────────
  describe("metrics/audit 分片落盘", () => {
    let dir: string;

    beforeEach(() => {
      dir = mkScratch("ctx-obs-shard-");
      process.env["DSH_HOME"] = dir;
    });

    it("HOME 兜底路径（DSH_HOME 未设）→ HOME/.dsh/cache/ctx-observe", () => {
      withEnv({ DSH_HOME: undefined, HOME: dir }, () => {
        const mock = createHost({ ...DEFAULT_VALUE, metricsEnabled: true });
        emit(
          mock,
          { id: "home1" },
          {
            type: ASSISTANT_MESSAGE_EVENT,
            data: { turn: 1, usage: { totalTokens: 5 } },
          },
        );
        // 兜底根由 home-paths 的 defaultDshHome() 给出（`~/.dsh`），本包只在其
        // cache 下认领自己的子目录；自制解析里那条 `${HOME}/.dsh/metrics` 拼法
        // 已随实现一起删除。
        const fallbackHome = path.join(dir, ".dsh");
        assert.ok(existsSync(metricsPath(fallbackHome)), "HOME 兜底路径落盘");
      });
    });

    it("不变式：落盘失败只在 catch 里记日志，绝不在 session/event 热路径抛出", () => {
      // DSH_HOME 指向一个普通文件 → 解析本身照样成功（home-paths 只算路径不碰
      // 磁盘），失败发生在建目录/追加这一步。路径解析与写入同在 appendMetric 的
      // 一个 try 里，所以无论是哪一种 IO 失败（ENOTDIR/EACCES/ENOSPC…）出口都只有
      // 一条：记日志 + 丢这一行。事件分发是同步洪流，这里抛出会打断宿主。
      const blocker = path.join(dir, "blocker");
      writeFileSync(blocker, "x");
      process.env["DSH_HOME"] = blocker;
      const mock = createHost({ ...DEFAULT_VALUE, metricsEnabled: true });
      assert.doesNotThrow(() => {
        emit(
          mock,
          { id: "f1" },
          {
            type: ASSISTANT_MESSAGE_EVENT,
            data: { turn: 1, usage: { totalTokens: 1 } },
          },
        );
      });
      assert.match(loggedText(), /metric append failed/u);
    });

    it("事件形状边界：null session / 非对象 event / type 非串 → 跳过不抛", () => {
      const mock = createHost({ ...DEFAULT_VALUE, metricsEnabled: true });
      emit(mock, { id: "x" }, undefined);
      emit(mock, { id: "x" }, {});
      emit(mock, { id: "x" }, { type: 42, data: {} });
      emit(mock, null, {
        type: ASSISTANT_MESSAGE_EVENT,
        data: { turn: 1, usage: { totalTokens: 1 } },
      });
      emit(
        mock,
        {},
        { type: ASSISTANT_MESSAGE_EVENT, data: { turn: 1, usage: { totalTokens: 7 } } },
      );
      const sessions = metricRows(dir).map((row) => row["session"]);
      assert.deepEqual(sessions, ["default"], "session 无 id → 记入 default");
    });

    it("usage 全缺 → 落一行 tokens:0（provider 只报聚合时归零而非丢条）", () => {
      const mock = createHost({ ...DEFAULT_VALUE, metricsEnabled: true });
      emit(mock, { id: "p1" }, { type: ASSISTANT_MESSAGE_EVENT, data: { turn: 2, usage: {} } });
      assert.equal(metricRows(dir).at(-1)?.["tokens"], 0);
    });

    it("子代理 header.origin=subagent（无 delegationDepth）→ 不记账", () => {
      const mock = createHost({ ...DEFAULT_VALUE, metricsEnabled: true });
      emit(
        mock,
        { id: "sub3", header: { origin: "subagent" } },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: { turn: 1, usage: { totalTokens: 999 } },
        },
      );
      assert.equal(metricRows(dir).length, 0);
    });

    it("探针落盘：畸形决策审计行进 pre-step-audit 分片", async () => {
      const mock = createHost();
      const outer = chainAt(mock, 1);
      await outer(payloadFor("audited"), malformedProducer);
      const findings = linesOf(auditPath(dir)).map(
        (line) => JSON.parse(line) as Record<string, unknown>,
      );
      assert.equal(findings[0]?.["tag"], "outer");
      assert.equal(findings[0]["finding"], ENTER_WITHOUT_MESSAGES_FINDING);
      assert.equal(findings[0]["sid"], "audited");
    });

    it("探针落盘失败（DSH_HOME 指向文件）→ 静默丢条、决策仍透传", async () => {
      const mock = createHost();
      const blocker = path.join(dir, "blocker");
      writeFileSync(blocker, "x");
      process.env["DSH_HOME"] = blocker;
      const decision = { kind: "enter", messages: [] };
      const outer = chainAt(mock, 1);
      const out = await outer(payloadFor("audited"), async () => decision);
      assert.deepEqual(out, decision);
    });

    it("探针条数上限：AUDIT_MAX_ROWS 之后不再落盘（防膨胀）", async () => {
      const mock = createHost();
      const inner = chainAt(mock, 2);
      const attempts = Array.from({ length: 402 }, (_unused, index) => index);
      await Promise.all(
        attempts.map(async (index: number): Promise<unknown> =>
          inner(payloadFor(`cap-${String(index)}`), malformedProducer),
        ),
      );
      assert.equal(linesOf(auditPath(dir)).length, 400, "达上限后停止落盘");
    });

    it("分片超限 → 重写为尾部一半（有界，不切断 JSON 行）", () => {
      const file = metricsPath(dir);
      mkdirSync(path.dirname(file), { recursive: true });
      const rows = Array.from({ length: 400 }, (_unused, index) =>
        JSON.stringify({ ts: index, session: `s${String(index)}`, tokens: index }),
      );
      writeFileSync(file, `${rows.join("\n")}\n`);
      trimMetricsFile(file, 1024);
      const kept = linesOf(file);
      assert.ok(kept.length < 400, "超限后行数减少");
      assert.ok(statSync(file).size <= 1024, "循环收缩到上限以内");
      const firstKept = JSON.parse(kept[0]!) as { ts: number };
      assert.ok(firstKept.ts >= 200, "首条保留行来自文件后半段");
      for (const line of kept) {
        const row = JSON.parse(line) as { session: string };
        assert.equal(typeof row.session, "string", "每行仍是合法 JSON（未切断行）");
      }
      const sizeBefore = readFileSync(file, "utf8").length;
      trimMetricsFile(file, 1024);
      assert.equal(readFileSync(file, "utf8").length, sizeBefore, "已低于上限不再变化");
    });

    it("单行超限 → 保底保留（不无限循环不截断）", () => {
      const file = metricsPath(dir);
      mkdirSync(path.dirname(file), { recursive: true });
      const single = "x".repeat(4096);
      writeFileSync(file, single);
      trimMetricsFile(file, 1024);
      assert.equal(readFileSync(file, "utf8"), single, "单行超限原样保留");
    });

    it("对半收缩 keep 以换行开头 → 去掉前导换行（不产生空首行）", () => {
      const file = metricsPath(dir);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "a\n\nb");
      trimMetricsFile(file, 2);
      assert.equal(readFileSync(file, "utf8"), "b");
    });

    it("文件不存在 → 收缩静默（不抛）", () => {
      assert.doesNotThrow(() => {
        trimMetricsFile(path.join(cacheShardDir(dir), "missing.jsonl"), 1024);
      }, "文件不存在时收缩应静默返回，不抛");
    });

    it("多进程并发 append：无丢行、无交错、分片互不污染", async () => {
      const report = await spawnMetricWriters(3, 2200, dir);
      assert.deepEqual(
        report.map((child) => child.code),
        [0, 0, 0],
        `子进程全部正常退出：${JSON.stringify(report)}`,
      );
      const shards = metricShards(dir);
      assert.equal(shards.length, 3, `每进程一个分片：${JSON.stringify(shards)}`);
      let total = 0;
      for (const shard of shards) {
        const file = path.join(cacheShardDir(dir), shard);
        const owners = new Set<string>();
        for (const line of linesOf(file)) {
          const row = JSON.parse(line) as { session: string };
          owners.add(row.session);
        }
        assert.equal(owners.size, 1, "同一分片只属于一个进程（无跨进程交错）");
        total += linesOf(file).length;
      }
      assert.equal(total, 3 * 2200, "每进程 2200 行全在：无丢行");
    });

    it("多进程并发且各自触发 5MB 收缩：分片限内、行合法、单进程归属", async () => {
      const report = await spawnMetricWriters(2, 9000, dir);
      assert.deepEqual(
        report.map((child) => child.code),
        [0, 0],
        `子进程全部正常退出：${JSON.stringify(report)}`,
      );
      const shards = metricShards(dir);
      assert.equal(shards.length, 2);
      for (const shard of shards) {
        const file = path.join(cacheShardDir(dir), shard);
        assert.ok(
          statSync(file).size <= 5 * 1024 * 1024 + 4096,
          `分片收缩在 5MB 保险丝内：${shard} ${String(statSync(file).size)}`,
        );
        const owners = new Set<string>();
        for (const line of linesOf(file)) {
          const row = JSON.parse(line) as { session: string };
          owners.add(row.session);
        }
        assert.equal(owners.size, 1, "收缩重写期间没有其它进程的写入混进来");
      }
    });
  });

  // ── metrics 端点：聚合读 + 同源校验 + 生命周期 ──────────────────────────
  describe("metrics 端点", () => {
    let dir: string;
    let mock: HostMock;

    interface Response {
      code: number;
      body: string;
    }

    beforeEach(() => {
      dir = mkScratch("ctx-obs-route-");
      process.env["DSH_HOME"] = dir;
      mock = createHost({ ...DEFAULT_VALUE, metricsEnabled: true });
    });

    function invoke(
      headers: Record<string, unknown>,
      failWriteHead200 = false,
      url = METRICS_ENDPOINT,
    ): Response {
      const handler = mock.routes.get(METRICS_ENDPOINT);
      assert.ok(handler !== undefined, "端点已注册");
      const state: Response = { code: 0, body: "" };
      handler(
        { headers, url },
        {
          writeHead: (statusCode: number): void => {
            if (failWriteHead200 && statusCode === 200) {
              throw new Error("socket closed");
            }
            state.code = statusCode;
          },
          end: (resBody?: string): void => {
            state.body = resBody ?? "";
          },
        },
      );
      return state;
    }

    it("无 sec-fetch-site 头 / same-origin / none → 200；cross-site → 403", () => {
      assert.equal(invoke({}).code, 200);
      assert.equal(invoke({ "sec-fetch-site": SAME_ORIGIN_FETCH_SITE }).code, 200);
      assert.equal(invoke({ "sec-fetch-site": "none" }).code, 200);
      const rejected = invoke({ "sec-fetch-site": "cross-site" });
      assert.equal(rejected.code, 403);
      // F1-3：本包这段 403 从纯文本收敛成 shared 的 JSON 出口，**错误文本逐字保留**
      // ⇒ 断言覆盖的是同一个分支，只是形变了（不许删这条，它钉的是"跨源被拒"这件事）。
      assert.equal(
        rejected.body,
        JSON.stringify({ ok: false, error: "cross-origin request rejected" }),
      );
    });

    it("信任闸门：重绑定形态（Host 是外域、sec-fetch-site 与 Origin 自洽）必须 403", () => {
      // 只有 Host 腿拒得了它：页面把 evil.test 解析到 127.0.0.1 后，浏览器给出的
      // sec-fetch-site 就是 same-origin、Origin 也与 Host 相等。
      const rebound = invoke({
        host: "evil.test:8787",
        origin: "http://evil.test:8787",
        "sec-fetch-site": SAME_ORIGIN_FETCH_SITE,
      });
      assert.equal(rebound.code, 403);
      assert.equal(
        rebound.body,
        JSON.stringify({ ok: false, error: "untrusted host authority" }),
        "判据次序也得钉：Host 腿要先跑，否则这条会落成交叉源的文案",
      );
      // Host 与 Origin 同时可疑 ⇒ 仍报 Host 腿的文案（同一枚 403，理由唯一）。
      assert.equal(invoke({ host: "evil.test:8787", "sec-fetch-site": "cross-site" }).code, 403);
      // 回环权威 + 同源 Origin ⇒ 200（本地 CLI 与宿主 UI 的正常面）。
      assert.equal(invoke({ host: "127.0.0.1:8787" }).code, 200);
      assert.equal(invoke({ host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787" }).code, 200);
      // 缺 Host 是本地裸 socket / Node 客户端面（浏览器走不到）⇒ 200，这条把口径钉成断言。
      assert.equal(invoke({}).code, 200);
    });

    it("headers 非对象（异常 req）→ 视作无同源信息，200", () => {
      const handler = mock.routes.get(METRICS_ENDPOINT);
      assert.ok(handler !== undefined);
      let code = 0;
      handler(["not-an-object"], {
        writeHead: (statusCode: number): void => {
          code = statusCode;
        },
        end: (): void => {
          void 0;
        },
      });
      assert.equal(code, 200);
    });

    it("聚合本进程分片：tokens 按 native pressure，usage 原样透传", () => {
      emit(
        mock,
        { id: "m1" },
        {
          type: ASSISTANT_MESSAGE_EVENT,
          data: { turn: 2, usage: { inputTokens: 40, outputTokens: 5, totalTokens: 45 } },
        },
      );
      const { code, body } = invoke({ "sec-fetch-site": SAME_ORIGIN_FETCH_SITE });
      assert.equal(code, 200);
      const rows = body
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.["session"], "m1");
      assert.equal(rows[0]["tokens"], 40, "native pressure = input（无 cache 字段）");
      assert.equal(rows[0]["turn"], 2);
      assert.equal(rows[0]["contextWindow"], null, "未见过 request/context → 窗口为 null");
      const usage = rows[0]["usage"] as { inputTokens: number };
      assert.equal(usage.inputTokens, 40, "usage 原样透传");
    });

    it("聚合旧版单文件与其它进程分片并按 ts 升序；陌生文件与 cache 根目录一律忽略", () => {
      // 落盘位置搬进 `<home>/cache/ctx-observe` 后，cache/ 是**所有插件共用**的可丢弃
      // 数据区，于是"只读本包前缀"从礼貌问题变成正确性问题：读侧一旦把邻居的
      // jsonl 当自己的流水聚合，卡片与 context-budget 技能就会读到别家的数据。
      // 两层都要锁：① 只进本包子目录（cache 根上的陌生文件读不到）；
      // ② 子目录内也只认 `<prefix>(.<任意>)?.jsonl`（audit 分片与近似名不算）。
      const shardDir = cacheShardDir(dir);
      mkdirSync(shardDir, { recursive: true });
      writeFileSync(
        path.join(shardDir, `ctx-observe.${String(process.pid)}.jsonl`),
        '{"ts":4,"session":"mine"}\n',
      );
      writeFileSync(
        path.join(shardDir, "ctx-observe.999998.jsonl"),
        '{"ts":2,"session":"other"}\n',
      );
      // 升级前的单文件：含空行与一行非 JSON（ts 解析不出 → 排最前，不外抛）
      writeFileSync(
        path.join(shardDir, LEGACY_METRICS_FILE),
        'not-json\n{"ts":1,"session":"legacy"}\n\n',
      );
      writeFileSync(path.join(shardDir, "ctx-observe.notes.txt"), "ignore me");
      writeFileSync(path.join(shardDir, "pre-step-audit.999998.jsonl"), '{"ts":9}\n');
      writeFileSync(path.join(shardDir, "ctx-observex.jsonl"), '{"ts":8,"session":"lookalike"}\n');
      // 别人的缓存：躺在共用的 cache 根上，前缀一模一样也不归本包
      writeFileSync(
        path.join(dir, "cache", "ctx-observe.999997.jsonl"),
        '{"ts":7,"session":"outsider"}\n',
      );
      writeFileSync(
        path.join(dir, "cache", "lesson-loop.jsonl"),
        '{"ts":6,"session":"neighbour"}\n',
      );
      assert.deepEqual(invoke({}).body.split("\n"), [
        "not-json",
        '{"ts":1,"session":"legacy"}',
        '{"ts":2,"session":"other"}',
        '{"ts":4,"session":"mine"}',
      ]);
    });

    it("cache 子目录不存在 / 路径被文件占住 → 200 空正文（读侧异常不外露）", () => {
      // 旧用例的第二态是"DSH_HOME/HOME 均未设置 → 解析抛错被吞"。改用 home-paths 后
      // 解析是全函数、不再抛，而"两个都没设"会把读侧指向**真实家目录**（读的是开发者
      // 的 ~/.dsh/cache，结果不可预期）。读侧不变式改由两个确定态覆盖：目录还没建
      // （ENOENT）与目录位置被普通文件占住（ENOTDIR，非 ENOENT 那一支）。
      assert.equal(invoke({}).body, "", "目录还没建起来");
      const blocker = path.join(dir, "blocker");
      writeFileSync(blocker, "x");
      process.env["DSH_HOME"] = blocker;
      assert.equal(invoke({}).body, "", "非 ENOENT 的读失败同样被聚合读吞掉，不外露 500");
    });

    it("写响应失败（200 writeHead 抛错）→ 500 metrics read failed", () => {
      const { code, body } = invoke({}, true);
      assert.equal(code, 500);
      assert.equal(body, "metrics read failed");
    });

    it("?limit=N：ts 升序排序后的尾部 N 行（最近 N 条）；超过行数 = 全量", () => {
      for (const turn of [1, 2, 3]) {
        emit(
          mock,
          { id: "s-limit" },
          { type: ASSISTANT_MESSAGE_EVENT, data: { turn, usage: { totalTokens: 100 + turn } } },
        );
      }
      const all = invoke({}).body.trim().split("\n");
      assert.equal(all.length, 3, "缺席 = 全量（不为省 token 降能力的口径不变）");
      const two = invoke({}, false, "/_dsh/ctx-observe/metrics?limit=2").body.trim().split("\n");
      assert.deepEqual(two, all.slice(-2), "limit=2 取最近 2 行");
      const many = invoke({}, false, "/_dsh/ctx-observe/metrics?limit=99").body.trim().split("\n");
      assert.deepEqual(many, all, "limit 超过行数 = 全量");
    });

    it("?limit= 出现但非法（非数字 / 0 / 负数）→ 400 且点名", () => {
      assert.equal(invoke({}, false, "/_dsh/ctx-observe/metrics?limit=abc").code, 400);
      assert.equal(invoke({}, false, "/_dsh/ctx-observe/metrics?limit=0").code, 400);
      assert.equal(invoke({}, false, "/_dsh/ctx-observe/metrics?limit=-3").code, 400);
      assert.match(
        invoke({}, false, "/_dsh/ctx-observe/metrics?limit=0").body,
        /positive integer/u,
      );
    });

    it("effect 清理 → 端点注销（幂等）", () => {
      const factory = mock.effectFactories.at(-1);
      assert.ok(factory !== undefined, "端点注册走 effect 工厂");
      const cleanup = factory();
      assert.equal(typeof cleanup, "function");
      assert.ok(mock.routes.has(METRICS_ENDPOINT));
      // 工厂返回域按官方收成 `() => void`（见 HostMock.effectFactories），故这里没有
      // 「可能拿不到 disposer」这一支可写：上一行的 typeof 断言就是那道检查。
      cleanup();
      cleanup();
      assert.ok(!mock.routes.has(METRICS_ENDPOINT), "清理后端点注销");
    });

    it("webServer 已注入却读不到 → 不注册路由，且点名契约被打破（item 8）", () => {
      const headless = createHost(DEFAULT_VALUE, { webServer: false });
      assert.equal(headless.routes.size, 0);
      const at = headless.effectLabels.indexOf(METRICS_ROUTE_LABEL);
      assert.ok(at !== -1, "端点效应必须带标签注册（按标签取，避免与兄弟效应数量耦合）");
      const factory = headless.effectFactories[at];
      assert.ok(factory !== undefined);
      // 官方 `Context['effect']` 的两条重载（`SyncEffect` / `Effect`，installed
      // cordis/lib/types/fiber.d.ts:49-50）都不受理 `undefined`：「这一趟没有要清理的东西」
      // 在官方契约里是一枚**空 disposer**。旧断言盯 `undefined` 是被本包那份比官方宽的效果面
      // 镜像惯出来的，`effect` 改绑官方后那一路当场红（TS2769）。
      // 注册现在挂在 `inject(["webServer"])` 的子 fiber 上，故"读不到"只剩跨版本/异常 ctx
      // 这一条路：它不再是可静默的部署态，而是一次 error 级点名（真实宿主实测过 get 在 apply
      // 当时返回 undefined，那时它是正常的"还没到"，不是永久缺席）。
      const missing = factory();
      missing();
      missing();
      assert.equal(headless.routes.size, 0, "读不到服务实例不该注册任何路由（重复跑工厂也不补）");
      // createHost 那趟激活点一次，本用例再手跑一次工厂＝两次。旧断言盯"只警一次"是靠
      // `missingServiceWarned` 标志把后续静默掉——那时"读不到"是正常部署态（非 web profile），
      // 静默是对的。现在注册挂在 inject(["webServer"]) 的子 fiber 上，"读不到"只剩契约被打破
      // 一条路，每次激活都该出声：静默标志反而会把第二次、第三次的异常吞掉。
      const errors = (activeMockForLogs?.logCalls ?? [])
        .filter((call) => call.type === "error")
        .filter((call) => call.args.some((arg) => String(arg).includes("webServer")));
      assert.equal(errors.length, 2, "每趟激活各点名一次，不跨激活去重");
      assert.match(loggedText(), /metrics 端点未注册/u);
      assert.match(loggedText(), /已注入却读不到/u);
    });

    it("webServer 迟到 → 到位前不注册、到位即注册、离场即撤销（注册时机本身）", () => {
      // 这条钉的是本轮真正修好的语义：旧写法在 apply 里 get 一次，真实宿主上 webServer
      // 晚到位约 1.3s，于是端点**永不**注册。上面那条用例锁的是"注入到位却读不出"，
      // 锁不住时机——mock 的 inject 一直是同步立刻回调，所以补一个推迟到位的夹具。
      const late = createHost({ ...DEFAULT_VALUE, metricsEnabled: true }, { deferWebServer: true });
      assert.equal(late.routes.size, 0, "依赖未到位时不得注册路由");
      assert.ok(
        !late.effectLabels.includes(METRICS_ROUTE_LABEL),
        "注册效应随子 fiber 挂载，依赖没到位就不该存在",
      );
      assert.equal(loggedText(), "", "webServer 缺席是正常部署态（TUI），不该出声");

      late.attachWebServer();
      const at = late.effectLabels.indexOf(METRICS_ROUTE_LABEL);
      assert.ok(at !== -1, "依赖到位后子 fiber 激活、效应挂上");
      const handler = late.routes.get(METRICS_ENDPOINT);
      assert.ok(handler !== undefined, "到位即注册");

      // 再激活一次不该重复挂效应（attach 是一次性口，对齐 cordis 的"到位才回调"）。
      late.attachWebServer();
      assert.equal(
        late.effectLabels.filter((label) => label === METRICS_ROUTE_LABEL).length,
        1,
        "重复 attach 不重复挂载",
      );

      const disposer = late.effectDisposers[at];
      assert.ok(disposer !== undefined, "注册成功时交回 disposer");
      disposer();
      assert.equal(late.routes.size, 0, "服务离场即撤销路由，不留悬挂注册");
    });
  });

  // ── 行级 config（0.1.7：cordis 按 Config schema 解析并填默认 → apply 收 volatile 引用）──
  // 旧断言盯的是「插件把行 config 合进 BUILTIN_BASE 后交给 settings.register 的 base」。
  // 0.1.7 把这两件事都收走了：底座 = schema 的 `.default()`，合并 = cordis 装载期
  // （vendor/cordis/src/fiber.ts resolveConfig）。所以这里改盯**仍然由本包负责**的三件事：
  // 默认值逐字段没写错、哨兵字段确实没有默认、读的是引用而不是 apply 期的快照。
  describe("行级 config", () => {
    it("Config schema 默认值逐字段对齐文档口径（0.1.6 base 的等价迁移）", () => {
      assert.deepEqual(schemaDefaults(), {
        enabled: true,
        suggestEnabled: true,
        contextThresholdTokens: undefined,
        contextRatio: 0.7,
        remindRatio: 0.05,
        metricsEnabled: true,
        metricsRetentionDays: 30,
        remindIntervalTokens: DEFAULT_INTERVAL,
        toolCountFirst: DEFAULT_TOOL_FIRST,
        toolCountInterval: DEFAULT_TOOL_INTERVAL,
        fallbackWindow: FALLBACK_WINDOW,
      });
    });

    it("contextThresholdTokens 无默认：undefined 哨兵不被默认值永久掩掉", () => {
      // 给了默认值就等于"显式配置优先"永远命中、窗口比例永不生效（v5 隐藏 bug 根因）。
      const field = configDict()["contextThresholdTokens"];
      assert.equal(field?.meta?.["default"], undefined);
      assert.equal(field?.meta?.["volatile"], true, "哨兵字段也得可编辑，否则设置卡读不到它");
    });

    it("读的是引用不是快照：改比例后已建 watcher 立刻生效（不需重挂载）", async () => {
      const mock = createHost({ ...DEFAULT_VALUE, metricsEnabled: true });
      emit(
        mock,
        { id: "live" },
        { type: REQUEST_CONTEXT_EVENT, data: { contextWindow: 1_000_000 } },
      );
      emit(
        mock,
        { id: "live" },
        { type: ASSISTANT_MESSAGE_EVENT, data: { turn: 1, usage: { inputTokens: 600_000 } } },
      );
      // 默认 contextRatio 0.7 → 线在 700k：600k 未越线。
      assert.equal(await askAt(mock, "live"), 0, "600k < 700k，不该有建议");
      // 设置卡把触发点压到 50%（宿主经 loader/volatile-update 提交进**同一枚**引用）。
      mock.value["contextRatio"] = 0.5;
      assert.equal(await askAt(mock, "live"), 1, "线降到 500k：同一个已建 watcher 立刻给出建议");
    });
  });

  // ── 0.1.7 隐式注册验收：volatileForm(Config) 的字段集 = 设置卡的可编辑字段集 ──
  //
  // 为什么单独要这一条：0.1.7 的命名空间与可编辑字段都是**从 schema 反推**的，
  // 漏写一个 `.volatile()` 不会报错，只会让那一项从设置卡上**静默消失**（宿主的 describe()
  // 只投影 volatileForm 的结果）；全漏则整条被跳过（settings/index.ts:308-309）、
  // 写入抛 `has no volatile fields`（:386）。这类退化单元测试全绿，只有拿宿主同一个
  // 判据回头看 schema 才拦得住。
  //
  // ⚠ 它能拦住的：字段级 volatile 漏标/多标、字段名漂移、条目 id 与 schema 不同源。
  // 它**拦不住**的（仍靠真实宿主启动或人工核对）：
  //   1. 行 id 接线 —— 命名空间取的是 profile 条目 `options.id`，即 ~/.dsh 里那份
  //      **已装配的** profile 文档，本包 cordis.patch.yml 只是它的来源；profile 被
  //      手工改过/别处也 insert 了同名条目时，这里断言的 id 与实际 ns 依然会错开。
  //   2. `fiber.runtime.Config` —— 宿主读的是装载后 runtime 上那份 Config
  //      （settings/index.ts:425-428 `'toJSON' in schema` 才算数）。本包导出的是同一个
  //      对象引用，但"cordis 真的把它挂上了 runtime"这一步不在单测射程内。
  //   3. 线路脱敏 —— `redactSecrets` 只对 `role('secret')` 生效；本包没有密钥字段，
  //      而 role→脱敏这条链只有在 wire 层（describe({redactSecrets:true})）才看得到。
  describe("0.1.7 隐式注册验收", () => {
    /** 设置卡该能编辑的字段（本包七项全是实时项，一个都不该漏）。 */
    const EDITABLE = [
      "contextRatio",
      "contextThresholdTokens",
      "enabled",
      "metricsEnabled",
      "metricsRetentionDays",
      "remindIntervalTokens",
      "remindRatio",
      "suggestEnabled",
      "toolCountFirst",
      "toolCountInterval",
    ];

    it("命名空间 = cordis.patch.yml 的条目 id", () => {
      assert.equal(patchEntryId(), PLUGIN_NAMESPACE);
    });

    it("volatileForm(Config) 的字段集恰为十项可编辑字段（含提醒节奏三旋钮）", () => {
      const form = volatileFormOf(plugin.Config as unknown as SchemaNode);
      assert.ok(form !== null, "没有任何 volatile 字段 → 宿主 describe() 整条跳过本条目");
      assert.deepEqual(form.toSorted(), EDITABLE, "投影字段集与设置卡预期可编辑项不一致");
      assert.deepEqual(
        Object.keys(configDict()).toSorted(),
        [...EDITABLE, "fallbackWindow"].toSorted(),
        "schema 字段全集 = 投影可编辑集 + 非 volatile 部署值（fallbackWindow）。" +
          "漏标 .volatile() 会让那一项从设置卡上静默消失，新增字段要同步这张期望清单",
      );
    });
  });

  // ── pruneToCapacity（生产容量纪律；旧名 pruneOldestForTests 是测试名误用）──
  describe("pruneToCapacity 边界", () => {
    it("300 条目一次 prune 压回 ≤200 且保留 keepId", () => {
      const map = new Map<string, number>();
      for (let index = 0; index < 300; index += 1) {
        map.set(`s${String(index)}`, index);
      }
      map.set("keep", 999);
      pruneToCapacity(map, "keep", 200);
      assert.ok(map.size <= 200, `一次 prune 压回 ≤200，实际 ${String(map.size)}`);
      assert.ok(map.has("keep"), "keepId 保留");
    });

    it("map 只有 keepId → 无受害者即停（不删 keepId）", () => {
      const map = new Map<string, number>([["keep", 1]]);
      pruneToCapacity(map, "keep", 0);
      assert.equal(map.size, 1);
      assert.ok(map.has("keep"));
    });
  });

  // ── 分片留存回收（磁盘卫生：不回收就是每启动一个进程永久多一份）────────────
  describe("分片留存回收", () => {
    const DAY_MS = 86_400_000;
    const PREFIXES = [PLUGIN_NAMESPACE, "pre-step-audit"];

    /** 一份 metrics 目录样本：过期外来分片 + 新鲜外来分片 + 旧版单文件 + 本进程分片。 */
    interface ShardSet {
      stale: string;
      fresh: string;
      legacy: string;
      own: string;
    }

    async function seedShards(dir: string): Promise<ShardSet> {
      const shardDir = cacheShardDir(dir);
      mkdirSync(shardDir, { recursive: true });
      const alien = process.pid === 1 ? 2 : 3;
      const set: ShardSet = {
        stale: path.join(shardDir, `ctx-observe.${String(alien)}.jsonl`),
        fresh: path.join(shardDir, `ctx-observe.${String(alien + 1)}.jsonl`),
        legacy: path.join(shardDir, LEGACY_METRICS_FILE),
        own: path.join(shardDir, `ctx-observe.${String(process.pid)}.jsonl`),
      };
      writeFileSync(set.stale, "{}\n");
      writeFileSync(set.fresh, "{}\n");
      writeFileSync(set.legacy, "{}\n");
      writeFileSync(set.own, "{}\n");
      // 造"90 天前末次写入"：node/no-sync 禁同步 utimesSync，用异步版。
      const longAgo = new Date(Date.now() - 90 * DAY_MS);
      await utimes(set.stale, longAgo, longAgo);
      return set;
    }

    it("planShardSweep 只挑出别的过程留下的、已过留存期的分片", () => {
      const now = 1_700_000_000_000;
      const staleMetrics = "ctx-observe.4242.jsonl";
      const staleAudit = "pre-step-audit.4242.jsonl";
      const entries = [
        { name: staleMetrics, mtimeMs: now - 40 * DAY_MS },
        { name: `ctx-observe.${String(process.pid)}.jsonl`, mtimeMs: now - 40 * DAY_MS },
        { name: LEGACY_METRICS_FILE, mtimeMs: now - 400 * DAY_MS },
        { name: staleAudit, mtimeMs: now - 40 * DAY_MS },
        { name: "ctx-observe.4243.jsonl", mtimeMs: now - DAY_MS },
        { name: "settings.yaml", mtimeMs: now - 400 * DAY_MS },
        { name: "ctx-observe.99999999999999999999.jsonl", mtimeMs: now - 400 * DAY_MS },
      ];
      assert.deepEqual(
        planShardSweep(entries, {
          nowMs: now,
          currentPid: process.pid,
          retentionDays: 30,
          prefixes: PREFIXES,
        }),
        [staleMetrics, staleAudit],
        "本进程分片 / 旧版单文件 / 未过期分片 / 非本插件文件 / pid 溢出的名字一律不选",
      );
    });

    it("retentionDays ≤ 0 = 永久保留（不选任何分片）", () => {
      const entries = [{ name: "ctx-observe.4242.jsonl", mtimeMs: 0 }];
      assert.deepEqual(
        planShardSweep(entries, {
          nowMs: 100 * DAY_MS,
          currentPid: 1,
          retentionDays: 0,
          prefixes: PREFIXES,
        }),
        [],
      );
    });

    it("启动时按留存期回收：只删过期外来分片，本进程与旧版单文件原样保留", async () => {
      const dir = mkScratch("ctx-sweep-");
      const files = await seedShards(dir);
      withEnv({ DSH_HOME: dir }, () => {
        createHost({ ...DEFAULT_VALUE, metricsEnabled: true, metricsRetentionDays: 30 });
      });
      assert.ok(!existsSync(files.stale), "过期且属主非本进程的分片被回收");
      for (const kept of [files.fresh, files.legacy, files.own]) {
        assert.ok(existsSync(kept), "新鲜外来分片 / 旧版单文件 / 本进程分片都不该动");
      }
      assert.ok(
        (activeMockForLogs?.logCalls ?? []).some(
          (call) =>
            call.type === "info" && call.args.some((arg) => String(arg).includes("回收 1 个过期")),
        ),
        "回收数量要能从日志看出来",
      );
    });

    it("回收只扫本包 cache 子目录：共用 cache 根上别人的过期文件不删", async () => {
      // 删除是不可逆操作，落点搬到共用的 cache/ 之后必须先确认"扫哪个目录"——
      // 本包只认领 cache/ctx-observe，cache 根上的陌生文件（别家的 jsonl）哪怕
      // 名字像、mtime 更老也不该被本进程的留存回收碰。
      const dir = mkScratch("ctx-sweep-foreign-");
      const shardDir = cacheShardDir(dir);
      mkdirSync(shardDir, { recursive: true });
      const alien = process.pid === 1 ? 2 : 3;
      const oursStale = path.join(shardDir, `ctx-observe.${String(alien)}.jsonl`);
      const theirsStale = path.join(dir, "cache", `lesson-loop.${String(alien)}.jsonl`);
      writeFileSync(oursStale, "{}\n");
      writeFileSync(theirsStale, "{}\n");
      const longAgo = new Date(Date.now() - 90 * DAY_MS);
      await Promise.all([
        utimes(oursStale, longAgo, longAgo),
        utimes(theirsStale, longAgo, longAgo),
      ]);
      withEnv({ DSH_HOME: dir }, () => {
        createHost({ ...DEFAULT_VALUE, metricsEnabled: true, metricsRetentionDays: 30 });
      });
      assert.ok(!existsSync(oursStale), "本包过期外来分片照常回收");
      assert.ok(existsSync(theirsStale), "别人的文件不在本包的回收范围内");
    });

    it("cache 子目录位置被普通文件占住 → 回收跳过：只 warn 一次，不炸插件", () => {
      // 自制解析时代这条 catch 由"DSH_HOME/HOME 都没设 → 解析抛错"覆盖；换成
      // home-paths 后解析不再抛，失败只能来自目录本身。这里让 `cache/ctx-observe`
      // 是个文件（existsSync 为真、readdirSync 立刻 ENOTDIR），验证启动效应把这种
      // 脏态咽下去——清理是磁盘卫生，不是功能。
      const blockerHome = mkScratch("ctx-sweep-blocker-");
      mkdirSync(path.join(blockerHome, "cache"), { recursive: true });
      writeFileSync(cacheShardDir(blockerHome), "not a directory");
      withEnv({ DSH_HOME: blockerHome }, () => {
        assert.doesNotThrow(() => {
          createHost({ ...DEFAULT_VALUE, metricsEnabled: true, metricsRetentionDays: 30 });
        });
      });
      assert.match(loggedText(), /分片回收跳过/u, "读不了要留痕，但不能抛");
    });

    it("metrics 关闭 / 留存设 0 / 设置读不到 → 一律不删（回收不可逆，宁可不作）", async () => {
      const skips: [string, Record<string, unknown>][] = [
        ["metrics 关闭", { ...DEFAULT_VALUE, metricsRetentionDays: 30 }],
        ["留存期 0", { ...DEFAULT_VALUE, metricsEnabled: true, metricsRetentionDays: 0 }],
      ];
      // 先并发铺好样本（异步 utimes），再同步逐个跑 apply，避免 await-in-loop。
      const dirs = skips.map(() => mkScratch("ctx-sweep-skip-"));
      const sets = await Promise.all(dirs.map(async (dir) => seedShards(dir)));
      for (const [index, [title, value]] of skips.entries()) {
        const dir = dirs[index];
        const files = sets[index];
        assert.ok(dir !== undefined && files !== undefined, `${title}：样本齐备`);
        withEnv({ DSH_HOME: dir }, () => {
          createHost(value);
        });
        assert.ok(existsSync(files.stale), `${title}：不应回收`);
      }
      const dir = mkScratch("ctx-sweep-boom-");
      const files = await seedShards(dir);
      withEnv({ DSH_HOME: dir }, () => {
        // 0.1.7 里"读设置"这件事不再有失败路径（引用取的是已解析好的冻结快照），
        // 旧用例的 throws 通道随之消失。fail-closed 的策略本身留着，换个可达形态：
        // 引用里压根没有值（字段缺失）→ metricsEnabled 不是 true → 一律不删。
        createHost({});
      });
      assert.ok(existsSync(files.stale), "读不到 settings 值：不拿默认值去猜用户的永不回收");
    });

    it("留存期缺字段 → 由 Config schema 的 .default(30) 兜住，到点照常回收", async () => {
      // 0.1.6 这条走的是插件内的 `Number.isFinite(raw) ? raw : 内置默认`；
      // 0.1.7 填默认改由 cordis 在校验期用同一份 schema 完成（fiber.ts resolveConfig），
      // 插件侧不再有兜底代码。故断言拆两半：schema 确实带了这个默认 + 拿到 30 就回收。
      assert.equal(schemaDefaults()["metricsRetentionDays"], 30, "留存期默认必须仍是 30 天");
      const dir = mkScratch("ctx-sweep-default-");
      const files = await seedShards(dir);
      withEnv({ DSH_HOME: dir }, () => {
        // 30 就是上一行断言的那个 schema 默认，cordis 会把它填进引用。
        createHost({ ...DEFAULT_VALUE, metricsEnabled: true, metricsRetentionDays: 30 });
      });
      assert.ok(!existsSync(files.stale), "按默认留存期 30 天回收");
    });

    it("metrics 目录还不存在（首次运行）→ 静默跳过，不刷警告", () => {
      const dir = mkScratch("ctx-sweep-nodir-");
      withEnv({ DSH_HOME: dir }, () => {
        createHost({ ...DEFAULT_VALUE, metricsEnabled: true, metricsRetentionDays: 30 });
      });
      assert.equal(logged.warns.length, 0, "目录缺失是常态，不该 warn");
    });
  });
});
