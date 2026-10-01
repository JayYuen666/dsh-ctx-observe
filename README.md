# @jayyuen66/dsh-ctx-observe

[中文](#中文) · [English](#english)

## 中文

### 它做什么

- 三件事：观测每回合上下文用量、在 `agent/pre-step` 注入一条**非强制**的战略压缩建议、把逐回合 token 流水落成 JSONL 并由本地端点聚合回读。
- 触发口径：阈值 = 权威 `contextWindow` × `contextRatio`（默认 0.7）。
  - 窗口取自宿主 `request/context` 事件，缺席时兜底读 `session.requestContext()`。
  - 两路都没有则回落 89600（= 最小常见窗 128k × 0.7）。
- 用量口径：native pressure = `inputTokens + cacheReadTokens + cacheWriteTokens`（不含 output），仅当 `inputTokens` 缺失时回落 `totalTokens`。
  - usage 走官方折叠口径：`assistant/message` 的 `data.usage` 优先，缺席取 `data.stream` 里最后一个 `type:'usage'` chunk。
  - `assistant/attempt` 只有 stream 一条路。
- 提醒节奏：达阈值提醒一次，此后再涨「窗口 × `remindRatio`」（默认 5%）才重复；用量回落超过一个间隔即视为已压缩、重新武装。
  - tokens 未知时走辅信号：第 50 次工具调用首提、此后每 25 次。

### 安装

```sh
dsh plugin --profile web add @jayyuen66/dsh-ctx-observe
```

- 需要 dsh `>=0.2.0-rc.2`：真源是 `package.json` 里 `peerDependencies` 下的 `@deepseek-ai/dsh`（宿主自 0.1.7-rc 起在装插件时校验它；alpha.1 还没有这道门，所以这行是说明不是保险）。`engines.dsh` 同值但无人读。
- 包在公共 npm（`registry.npmjs.org`）上，安装不需要任何凭据。
- 卸载：`dsh plugin --profile web remove @jayyuen66/dsh-ctx-observe`。源码仓地址见 `package.json` 的 `repository.url`。

### 在 dsh 里启用

- 组合包（bundle）形态：包内 `cordis.patch.yml` 带 `- id: ctx-observe` + `name: "@jayyuen66/dsh-ctx-observe"`，由 `package.json` 的 `dsh.bundle.patch` 指向，`dsh plugin add` 自动登记并激活配置层。
- 卡片只在 web profile 出现（`dsh.client.platform = web`、`immediately = true`）；宿主侧观测与建议不依赖卡片。
- 设置页里那张卡（标题 `ctx-observe 上下文观测` / `ctx-observe context watch`）：改动先暂存，点「保存」才写进 profile 的配置文档，「撤销」丢弃本地改动。
  - 0.1.7 没有独立的「运行时值」层：一次保存落的就是本条目那行 `config:`。
- 不想开 UI：部署默认值写在注册行的 `config:` 上（按裸值写，就是下表的 11 个字段），由 cordis 用下表的同一份 schema 校验并填默认。
  - 优先级 = 用户层行 `config`（设置卡保存即写进这里）> 继承层行 `config`（组合包自带那份）> schema 默认值。
- 用到的宿主服务：`settings` 是硬依赖（`inject: ["settings"]`）；`webServer` 走 `ctx.inject(["webServer"], …)` 的子 fiber 建立依赖——**不是**只 `ctx.get` 读一次：真实宿主上 webServer 比本插件晚到位约 1 秒（隔离 DSH_HOME 实测：apply 当场 `get` 返回 `undefined`，+1.3s 才交得出实例），只读一次的结果是端点永不注册。

### 设置项

命名空间 `ctx-observe`（= profile 条目 id）；`host.ts` 里 settings 与行 `config` 共用同一份 `configSchema`（单源防漂移），默认值逐字段写在该 schema 的 `.default(...)` 上。

| 字段名                   | 类型                          | 默认值   | 作用                                                                                                           |
| ------------------------ | ----------------------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `enabled`                | boolean                       | `true`   | 总开关：关掉后不观测 usage、不注入建议、不落 metrics                                                           |
| `suggestEnabled`         | boolean                       | `true`   | 只关压缩建议注入，观测与 metrics 照旧                                                                          |
| `contextThresholdTokens` | number（自然数，≤ 2000000）   | 未设置   | 显式绝对阈值（token），配置后永远优先于窗口比例；清空即撤销、回到窗口比例口径                                  |
| `contextRatio`           | number（0.1–0.95，步长 0.05） | `0.7`    | 触发点 = contextWindow × 该比例                                                                                |
| `remindRatio`            | number（0.01–0.3，步长 0.01） | `0.05`   | 提醒后重复间隔，也是回落重武装的判据                                                                           |
| `metricsEnabled`         | boolean                       | `true`   | 每回合流水是否落盘；关闭时启动期的分片回收一并不执行                                                           |
| `metricsRetentionDays`   | number（自然数，≤ 3650）      | `30`     | 启动时回收其它进程留下的、末次写入超期的分片；`0` = 永久保留不回收                                             |
| `remindIntervalTokens`   | number（自然数）              | `60000`  | 无窗口信息（legacy 兜底）时的重复提醒间隔（token）——provider 不报 usage 时它是唯一可见节奏                     |
| `toolCountFirst`         | number（自然数）              | `50`     | tokens 未知时的辅信号：第 N 次工具调用首次提醒                                                                 |
| `toolCountInterval`      | number（自然数）              | `25`     | 上述辅信号的重复间隔（按工具调用次数计）                                                                       |
| `fallbackWindow`         | number（自然数）              | `128000` | 窗口两路都取不到时假定的窗口（token）。非 volatile：部署假定值，设置卡上没有它那一行，只能改注册行的 `config:` |

前 10 项在设置卡上各有一行控件（`enabled`…`metricsRetentionDays` 与三行 `remindIntervalTokens` / `toolCountFirst` / `toolCountInterval`）；`fallbackWindow` 是唯一没有控件的第 11 项。

### 对外接口

- 本地端点 `/_dsh/ctx-observe/metrics`（`webServer.register` 的 `kind: "exact"` 路由）：回 `text/plain; charset=utf-8` + `cache-control: no-store`。
  - 正文是聚合本包 cache 子目录内 `ctx-observe*.jsonl` 全部分片、按行首 `ts` 升序的 JSONL；缺省为全量（不为省 token 而降能力）。
  - `?limit=N`：正整数取升序后的尾部 N 行（最近 N 条，N 大于行数自然回落全量）；非纯数字或 `0` → `400 invalid ?limit= (positive integer expected)`。
  - 每行字段：`ts / session / turn / tokens / contextWindow / usage`。
- 信任闸门：handler 体的第一条语句是 `shared/lib/trust` 的 `guardTrust(req, res, { servingNonLoopback })`，判据依次为 Host 权威 → `sec-fetch-site` 白名单 → `Origin` 逐字比对。
  - 任一不成立 → `403` + JSON `{ ok: false, error: "untrusted host authority" | "cross-origin request rejected" }`；读盘失败 → `500 metrics read failed`。
  - `servingNonLoopback` 只从 `webServer.host === "0.0.0.0"` 取，读不到按保守档 false（只认字面回环）。本包自制的 `siteOf` 判定与纯文本 403 已删。
- 模型可见的唯一面：往 pre-step 决策的 `messages` 末尾追加一条建议消息。
  - 消息字段：`role: "user"`、`source: { kind: "plugin:ctx-observe" }`、`id: ctx-observe-<uuid>`。
  - 正文是固定双语模板，不插值任何会话内容。
- client 半向插件管理页注入 `plugins.bundle.config` 槽位的卡片，key = bundle 包名 `@jayyuen66/dsh-ctx-observe`（该槽按包名 keyed，真源是 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles`）。
- client 半 `inject: ["slots", "configForms", "locale"]`；`configForms.get()` 与 settings 命名空间用的仍是裸条目 id `ctx-observe`——槽位 key 与条目 id 是两个标识，不是一回事。
- 不注册工具、不注册命令、不写 system prompt；全包唯一的外发调用是卡片 fetch 同源的 `/_dsh/ctx-observe/metrics`。

### 数据与隐私

- 只读宿主事件：`session/event` 的 `assistant/message`、`assistant/attempt`、`tool/call`、`request/context`，加 `session/disposed` 做清理；不读 transcript，也不改消息内容。
- 子代理会话（`header.delegationDepth > 0` 或 `header.origin === 'subagent'`）整条链退出：不记账、不落 metrics、不注入建议。
- 落盘位置：`<dsh 数据目录>/cache/ctx-observe/` 下的 `ctx-observe.<pid>.jsonl`（每回合流水）。
  - 数据目录根由 `@deepseek-ai/dsh-home-paths` 解析（`DSH_HOME` 优先、空白值视为未设）。
  - 按 pid 分片即单写者，跨进程不共享文件。
- 体积上限：单分片 5 MiB，超限按行对半收缩（不切断 JSON 行）。
  - 内存里 watchers/toolCounts 两张表各最多 200 个会话，超限淘汰最旧。
- `cache/` 在 dsh 语义里是「可丢弃的派生数据」：真源在 session 事件流，删掉 `cache/ctx-observe/` 不丢事实。`metricsEnabled = false` 停止写入，`metricsRetentionDays = 0` 关闭回收。

### 常见问题

- 装不上：404 多半是该版本还没发到 npmjs（先看 `dist-tags.latest`）。
  - 404 通常是同组库包 `@jayyuen66/dsh-plugin-shared` 还没上 registry——本包值 import 它的 `lib/locale`，缺了是 `ERR_MODULE_NOT_FOUND`，不降级。
- 卡片 metrics 区一直空：先确认这是 web profile。非 web 宿主（TUI）本就没有 webServer，子 fiber 不激活、端点不存在，而这是正常部署态，插件不再为此打日志。
  - 真要出问题时才会看到的是一条 error：`[ctx-observe] webServer 已注入却读不到服务实例，metrics 端点未注册`——它说的是"inject 说到位、get 却读不出"这种契约被打破的情形，不是宿主没装 webServer。
  - 注册路由的 effect 挂在 `inject(["webServer"])` 的子 fiber 上：设置卡改 `enabled` 不会重跑工厂，宿主换 webServer 实例会先卸后装。
- 从来不提醒：先确认 `enabled` 与 `suggestEnabled` 都为 `true`、当前是根会话。
  - provider 不报 usage 时只剩工具计数辅信号（50 首提 / 每 25）。
  - 只有两路都给不出窗口时才走兜底：窗口按 128000 记、默认比例下即 89600（旧版固定 160k 在 128k 窗上永不触发，已废弃）。
- 建议正文的中英文：host 读官方 `locale` 命名空间的 `preference`（`en-US` 落英文、`zh-Hans-CN` 落中文），下一次 pre-step 即生效。
  - 官方 locale 未注册时默认中文；卡片 UI 文案走官方 `ctx.locale`。
- 改比例或阈值要重启吗：不用。
  - 每次 `assistant/message` 与每次 pre-step 都会把 `contextRatio` / `remindRatio` / 显式阈值同步到已建 watcher，清空显式阈值立刻回到窗口比例口径。
- 建议被下游丢掉会不会白花名额：不会。判定与消费分离（`RemindProposal.commit`），只有建议真的进入决策 `messages` 才消费名额。
  - 非对象决策、`kind: 'reject'`、`messages` 非数组一律原样透传。

## English

### What it does

- Three jobs: observe per-turn context usage, inject one **non-binding** strategic compaction suggestion at `agent/pre-step`, and persist a per-turn token ledger as JSONL that a local endpoint reads back in aggregate.
- Trigger: threshold = authoritative `contextWindow` × `contextRatio` (0.7 by default).
  - The window comes from the host `request/context` event, or `session.requestContext()` when that event is absent.
  - With neither available it falls back to 89600 (= smallest common window 128k × 0.7).
- Usage metric: native pressure = `inputTokens + cacheReadTokens + cacheWriteTokens` (output excluded), falling back to `totalTokens` only when `inputTokens` is missing.
  - Usage follows the official folding rule: `assistant/message` `data.usage` first, otherwise the last `type:'usage'` chunk in `data.stream`.
  - `assistant/attempt` has only the stream path.
- Cadence: one reminder once the threshold is crossed, then only after another `window × remindRatio` (5%) of growth; usage dropping by more than one interval counts as "already compacted" and rearms.
  - When tokens are unknown the secondary signal applies: first at 50 tool calls, then every 25.

### Install

```sh
dsh plugin --profile web add @jayyuen66/dsh-ctx-observe
```

- Requires dsh `>=0.2.0-rc.2`: the source of truth is the `@deepseek-ai/dsh` entry under `peerDependencies` in `package.json` (`engines.dsh` carries the same value for readers only; the host never reads it).
- The packages live on the public npm registry, so installation needs no credentials.
- Remove with `dsh plugin --profile web remove @jayyuen66/dsh-ctx-observe`. Source repository: see `repository.url` in `package.json`.

### Enabling it in dsh

- Bundle form: the package's own `cordis.patch.yml` carries `- id: ctx-observe` + `name: "@jayyuen66/dsh-ctx-observe"` and is pointed at by `dsh.bundle.patch` in `package.json`; `dsh plugin add` registers and activates the config layer.
- The card only appears on the web profile (`dsh.client.platform = web`, `immediately = true`); host-side observation and suggestion do not depend on it.
- The card (titled `ctx-observe 上下文观测` / `ctx-observe context watch`) stages edits locally: Save writes them into the profile's configuration document, Revert discards them.
  - 0.1.7 has no separate "runtime value" layer: a Save lands on this entry's own `config:` row.
- No UI needed: deployment defaults go on the registration line's `config:` (plain values, the same 11 fields below), validated and default-filled by cordis against that one shared schema.
  - Precedence = user-layer line `config` (where the card's Save writes) > inherited layer (the bundle's own patch) > schema default.
- Host services used: `settings` is a hard dependency (`inject: ["settings"]`); the metrics route is mounted on an `inject(["webServer"])` **child fiber**, not on a one-off `ctx.get`.
  - Measured in an isolated DSH_HOME: at this entry's apply `get("webServer")` returned `undefined`, and a `WebServer` showed up at +1.3s - reading once means the route is never registered.

### Settings

Namespace `ctx-observe` (= the profile entry id); in `host.ts` the settings form and the line `config` share one `configSchema` (single source, drift-proof), and each default lives on its own field's `.default()` — 0.1.7 dropped the second registration layer, so there is no separate built-in base object.

| Field                    | Type                         | Default  | Purpose                                                                                                                                         |
| ------------------------ | ---------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                | boolean                      | `true`   | Master switch: off means no usage observation, no suggestion, no metrics written                                                                |
| `suggestEnabled`         | boolean                      | `true`   | Disables only the compaction suggestion; observation and metrics carry on                                                                       |
| `contextThresholdTokens` | number (natural, <= 2000000) | unset    | Explicit absolute threshold in tokens; always wins over the window ratio, clearing it reverts to the ratio                                      |
| `contextRatio`           | number (0.1-0.95, step 0.05) | `0.7`    | Trigger point = contextWindow x this ratio                                                                                                      |
| `remindRatio`            | number (0.01-0.3, step 0.01) | `0.05`   | Repeat interval after a reminder, and the drop-back re-arm criterion                                                                            |
| `metricsEnabled`         | boolean                      | `true`   | Whether the per-turn ledger is written; off also skips the startup shard sweep                                                                  |
| `metricsRetentionDays`   | number (natural, <= 3650)    | `30`     | At startup, reclaim shards left by other processes whose last write is older than this; `0` = keep forever                                      |
| `remindIntervalTokens`   | number (natural)             | `60000`  | Repeat interval (tokens) when no window info is available - the only visible cadence when the provider reports no usage                         |
| `toolCountFirst`         | number (natural)             | `50`     | Secondary signal when tokens are unknown: first reminder at the Nth tool call                                                                   |
| `toolCountInterval`      | number (natural)             | `25`     | Repeat interval of that secondary signal, counted in tool calls                                                                                 |
| `fallbackWindow`         | number (natural)             | `128000` | Window assumed when neither window source resolves. Not volatile: a deployment assumption with no card row, settable only on the line `config:` |

The first 10 fields each have a card row; `fallbackWindow` is the 11th and the only one without a control.

### Public surface

- Local endpoint `/_dsh/ctx-observe/metrics` (a `webServer.register` route with `kind: "exact"`): replies `text/plain; charset=utf-8` plus `cache-control: no-store`.
  - The body is the JSONL aggregated from every `ctx-observe*.jsonl` shard in this package's cache subdirectory, sorted ascending by the leading `ts`; the default is the full history (never narrowed to save tokens).
  - `?limit=N`: a positive integer takes the trailing N rows of that ascending order (N beyond the row count falls back to everything); anything non-numeric or `0` gets `400 invalid ?limit= (positive integer expected)`.
  - Each line holds `ts / session / turn / tokens / contextWindow / usage`.
- Trust gate: the first statement of the handler body is `guardTrust(req, res, { servingNonLoopback })` from `shared/lib/trust`, judged as Host authority -> `sec-fetch-site` allowlist -> verbatim `Origin` comparison.
  - Any failure -> `403` plus JSON `{ ok: false, error: "untrusted host authority" | "cross-origin request rejected" }`; a failed read gets `500 metrics read failed`.
  - `servingNonLoopback` comes only from `webServer.host === "0.0.0.0"`, defaulting to the conservative `false` (loopback literals only). The package's own `siteOf` check and plain-text 403 are gone.
- The only model-visible artifact: one message appended to the pre-step decision's `messages`.
  - Message fields: `role: "user"`, `source: { kind: "plugin:ctx-observe" }`, `id: ctx-observe-<uuid>`.
  - The text is a fixed bilingual template with no session content interpolated.
- The client half injects a card into the `plugins.bundle.config` slot on the plugin page, keyed by the bundle package name `@jayyuen66/dsh-ctx-observe` (source of truth: `dsh.profile.bundles` in `~/.dsh/profiles/web/package.json`).
- The client declares `inject: ["slots", "configForms", "locale"]`. `configForms.get()` and the settings namespace use the bare entry id `ctx-observe` — that id and the slot key above are two different identifiers.
- Registers no tools and no commands, writes nothing into the system prompt; the package's only outbound call is the card fetching its own same-origin `/_dsh/ctx-observe/metrics`.

### Data and privacy

- Host events only: `session/event` (`assistant/message`, `assistant/attempt`, `tool/call`, `request/context`) plus `session/disposed` for cleanup. No transcript reads, no message mutation.
- Sub-agent sessions (`header.delegationDepth > 0` or `header.origin === 'subagent'`) opt out of the whole chain: no accounting, no metrics rows, no suggestions.
- Written to `<dsh data dir>/cache/ctx-observe/` as `ctx-observe.<pid>.jsonl` (turn ledger).
  - The data root is resolved by `@deepseek-ai/dsh-home-paths` (`DSH_HOME` wins, a blank value counts as unset).
  - Per-pid shards mean a single writer per file, no cross-process sharing.
- Bounds: 5 MiB per shard, halved line-wise when exceeded (never mid-JSON).
  - The in-memory watchers and toolCounts maps hold at most 200 sessions each, oldest evicted.
- `cache/` is dsh's "discardable derived data": the session event stream stays the source of truth, so deleting `cache/ctx-observe/` loses no facts. `metricsEnabled = false` stops writes, `metricsRetentionDays = 0` disables reclamation.

### FAQ

- Install fails with 404: that version was never published to npmjs (check `dist-tags.latest`).
  - 404 usually means the sibling library package `@jayyuen66/dsh-plugin-shared` is not on the registry yet - this package value-imports its `lib/locale`, so a missing one is `ERR_MODULE_NOT_FOUND`, not a graceful downgrade.
- The card's metrics section stays empty: first check this is a web profile.
  - On a non-web host (TUI) there is no webServer, the child fiber never activates and the endpoint simply does not exist - a normal deployment shape, so the plugin no longer logs about it.
  - The one error you can still see is `[ctx-observe] webServer 已注入却读不到服务实例，metrics 端点未注册`, which means the inject contract was broken (declared available, `get` returned nothing), not that the host lacks webServer.
  - The route-registering effect hangs off the `inject(["webServer"])` child fiber: toggling `enabled` never re-runs the factory, while a host that swaps the webServer instance unloads and re-registers.
- Never reminded: first confirm `enabled` and `suggestEnabled` are both `true` and that the session is a root session.
  - Providers that report no usage leave only the tool-count signal (first at 50, then every 25).
  - A 128k window uses the 89600 fallback, not the legacy fixed 160k.
- Reminder language: the host reads `preference` from the official `locale` namespace (`en-US` to English, `zh-Hans-CN` to Chinese) and the next pre-step picks it up.
  - With the official locale plugin absent it defaults to Chinese; card UI strings go through the official `ctx.locale`.
- Restart needed after changing ratios or the threshold: no.
  - Every `assistant/message` and every pre-step re-syncs `contextRatio`, `remindRatio` and the explicit threshold onto existing watchers, and clearing the explicit threshold immediately returns to the window-ratio rule.
- Is a reminder quota wasted when downstream drops the suggestion: no. Deciding and consuming are separated (`RemindProposal.commit`) and quota is spent only when the suggestion actually lands in the decision `messages`.
  - Non-object decisions, `kind: 'reject'` and non-array `messages` are passed through verbatim.
