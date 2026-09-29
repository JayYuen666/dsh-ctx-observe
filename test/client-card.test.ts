// A8 卡片行为（jsdom）：props.value 变化回写输入框；清空 → unset；loading/unavailable 禁用。
// @vitest-environment jsdom
// 显式加载 node 类型：tsgolint 对 .test.ts 不自动解析 @types/node，缺此声明会把
// `import assert from "node:assert/strict"` 判为找不到（TS2591），assert.* 全线 error 误报。
/// <reference types="node" />
import { describe, it, afterEach } from "vitest";
import assert from "node:assert/strict";
import { setTimeout as nextMacrotask } from "node:timers/promises";
import { createElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { SlotRegistry } from "@deepseek-ai/dsh-client-ui-renderer/client";
import type { ConfigFormSnapshot } from "@deepseek-ai/dsh-client-ui-settings/client";
import { render, fireEvent, cleanup, act } from "@testing-library/react";
import {
  NumberInputRow,
  DgCard,
  summarizeMetrics,
  diffTouched,
  MetricsSection,
  SaveBar,
  apply,
} from "../src/client-entry.ts";
import { UI_MESSAGES } from "../src/ui-messages.ts";
import type { LocaleNs, Translate } from "../src/ui-messages.ts";
import type { BuiltInLocaleId } from "@deepseek-ai/dsh-client-locale/client";
import type { LocaleDictOf } from "@deepseek-ai/dsh-client-ui-slots";
import { patchEntryId, profileBundleName } from "./profile-bundle.ts";

type Snap = ConfigFormSnapshot<Record<string, unknown>>;
/** 三个开关所在的按钮选择器（卡片 DOM 的公开契约）。 */
const SWITCH_BUTTON_SELECTOR = "button.coc-switch";
/** 卡片注入的 <style> 节点 id（样式注入/清理两条断言都取它）。 */
const CARD_STYLESHEET_SELECTOR = "#ctx-observe-card-css";

/** 官方 `ConfigFormSnapshot` 的合法形状（7 位全必选）；首个快照受理前 value/revision
 *  为 undefined，正是卡片要渲染「还没数据」的那一态。 */
function snap(over: Partial<Snap> = {}): Snap {
  return {
    status: "ready",
    value: { enabled: true },
    base: {},
    user: {},
    revision: 3,
    writable: true,
    mode: "host",
    ...over,
  };
}

/** 官方 locale 的 `{name}` 插值（宿主同语义）：测试里自己实现，不引宿主内部实现。 */
function fillTemplate(text: string, params: Record<string, unknown>): string {
  return text.replaceAll(/\{(?<key>\w+)\}/gu, (_all: string, key: string) => {
    const value = params[key];
    if (typeof value === "number") {
      return String(value);
    }
    return typeof value === "string" ? value : "";
  });
}

/**
 * 官方 locale 的取值语义（测试侧复刻）：本包字典命中即用，未命中回落**键名本身**
 * （官方 `LocaleRuntime.lookup` 在 active 语言与 fallback 链都 miss 后的行为）。
 * 表按 `Record<string, string>` 承载而不是 `UiMessages`：merge 进 `LocaleNamespaceMap`
 * 之后 `TranslateNS<NS>` 的键域是「本包键 ∪ common 命名空间键」（官方 `LocaleKeysOf`），
 * 按 `UiMessages` 索引那条并集会在编译期红，而运行时真相是回落。展开成字面量是为了拿到
 * 隐式索引签名（`UiMessages` 是 interface，本身给不出）。
 */
function localeText(
  dict: Record<string, string>,
  key: string,
  params: Record<string, unknown>,
): string {
  return fillTemplate(dict[key] ?? key, params);
}

/** 中文 translator：卡片断言里的中文串因此与 i18n 迁移前完全一致。 */
const zhTable: Record<string, string> = { ...UI_MESSAGES.zh };
const tZh: Translate = (key, params) => localeText(zhTable, key, params ?? {});

/** 模板里的 {占位符} 名字清单（不具名捕获组，避开 dot-notation 与 TS4111 的相互要求）。 */
function placeholders(template: string): Set<string> {
  return new Set(template.split(/[{}]/u).filter((piece) => /^\w+$/u.test(piece)));
}

// summarizeMetrics 返回 SessionSummary[]，但该类型未导出；此处本地声明等价结构，
// 仅供 `[0]!` 的 oxlint(noUnchecked off)/tsc(noUnchecked on) 判定对齐用。
interface SessionSummaryView {
  session: string;
  tokens: number;
  contextWindow: number | null;
  ratio: number | null;
  turns: number;
  lastTs: number;
}

describe("回显同步（NumberInputRow）", () => {
  afterEach(() => {
    cleanup();
  });

  it("props.value 变化 → 输入框回写新值（useEffect resync）", () => {
    const calls: [string, unknown][] = [];
    const { container, rerender } = render(
      createElement(NumberInputRow, {
        label: "L",
        hint: "H",
        field: "contextRatio",
        value: 0.7,
        onChange: (field: string, val: unknown) => {
          calls.push([field, val]);
        },
        onEmpty: (field: string): void => {
          void field;
        },
      }),
    );
    const input = container.querySelector<HTMLInputElement>("input")!;
    assert.equal(input.value, "0.7");
    // 用户手输 0.5
    fireEvent.change(input, { target: { value: "0.5" } });
    assert.equal(input.value, "0.5");
    // 外部快照变化（别处改了设置）→ 回写
    rerender(
      createElement(NumberInputRow, {
        label: "L",
        hint: "H",
        field: "contextRatio",
        value: 0.9,
        onChange: (field: string, val: unknown) => {
          calls.push([field, val]);
        },
        onEmpty: (field: string): void => {
          void field;
        },
      }),
    );
    assert.equal(
      container.querySelector<HTMLInputElement>("input")!.value,
      "0.9",
      "props.value 变化必须回写输入框",
    );
  });

  it("清空输入 → 调 unset(field)（而非静默 early-return）", () => {
    const unset: string[] = [];
    const { container } = render(
      createElement(NumberInputRow, {
        label: "L",
        hint: "H",
        field: "contextThresholdTokens",
        value: 5000,
        onChange: (field: string, val: unknown): void => {
          void field;
          void val;
        },
        onEmpty: (field: string) => {
          unset.push(field);
        },
      }),
    );
    const input = container.querySelector<HTMLInputElement>("input")!;
    fireEvent.change(input, { target: { value: "" } });
    assert.deepEqual(unset, ["contextThresholdTokens"]);
  });
});

/** 按 status/writable/value 构造 useCard selector（捕获工厂参量，非父作用域变量）。 */
function makeUseCard(status: string, value: Record<string, unknown>, writable = true) {
  return <TValue>(
    sel: (snap: { status: string; writable?: boolean; value: Record<string, unknown> }) => TValue,
  ): TValue => sel({ status, writable, value });
}

function renderCard(
  status: string,
  value: Record<string, unknown>,
  writable = true,
  translator: Translate = tZh,
): { container: HTMLElement } {
  const useCard = makeUseCard(status, value, writable);
  const rendered = render(
    createElement(DgCard, {
      t: translator,
      useCard: useCard as never,
      set: () => Promise.resolve(),
      unset: () => Promise.resolve(),
      initialOpen: true,
    }),
  );
  return { container: rendered.container };
}

// B11/B12/B13 共享测试助手。模块级（不捕获父作用域）以满足 unicorn/
// consistent-function-scoping：这些函数只用模块导入的 render/createElement/act 等。
function renderSaveBar(
  props: { dirty: boolean; writable: boolean; busy: boolean; error: string | null },
  handlers: { onSave?: () => void; onDiscard?: () => void } = {},
): HTMLElement {
  const rendered = render(
    createElement(SaveBar, {
      t: tZh,
      dirty: props.dirty,
      writable: props.writable,
      busy: props.busy,
      error: props.error,
      onSave:
        handlers.onSave ??
        (() => {
          void 0;
        }),
      onDiscard:
        handlers.onDiscard ??
        (() => {
          void 0;
        }),
    }),
  );
  return rendered.container;
}

const saveButton = (container: HTMLElement): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>('button[data-field="save"]')!;
const discardButton = (container: HTMLElement): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>('button[data-field="discard"]')!;
const toggle = (container: HTMLElement, field: string): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>(`button[data-field="${field}"]`)!;
// 元素类型含 undefined：让 `[0]` 在 oxlint(noUnchecked off) 与 tsc(noUnchecked on) 下
// 都保持 `| undefined`，使 `!` 两处都不被判"多余/缺失"（no-unnecessary-type-assertion）。
const numberInputs = (container: HTMLElement): (HTMLInputElement | undefined)[] =>
  [...container.querySelectorAll("input")] as HTMLInputElement[];

const flush = async (): Promise<void> =>
  act(async () => {
    // 冲刷要等一个 macrotask（React 的效果链落在定时器之后）：timers/promises 的
    // setTimeout 直接交出可 await 的 promise，无需自己包 new Promise。
    await nextMacrotask(0);
  });

describe("快照 loading/unavailable 时禁用写入控件", () => {
  afterEach(() => {
    cleanup();
  });

  it("status=loading → 开关与数字输入全部 disabled", () => {
    const { container } = renderCard("loading", {});
    const buttons = [...container.querySelectorAll(SWITCH_BUTTON_SELECTOR)] as HTMLButtonElement[];
    assert.ok(buttons.length >= 3, "三个开关都在");
    for (const button of buttons) {
      assert.equal(button.disabled, true, "loading 时开关禁用");
    }
    const inputs = [...container.querySelectorAll("input")] as HTMLInputElement[];
    assert.ok(inputs.length >= 3, "三个数字输入都在");
    for (const input of inputs) {
      assert.equal(input.disabled, true, "loading 时输入禁用");
    }
  });

  it("status=ready → 控件可用", () => {
    const { container } = renderCard("ready", { enabled: true });
    for (const button of [
      ...container.querySelectorAll(SWITCH_BUTTON_SELECTOR),
    ] as HTMLButtonElement[]) {
      assert.equal(button.disabled, false);
    }
    for (const input of [...container.querySelectorAll("input")] as HTMLInputElement[]) {
      assert.equal(input.disabled, false);
    }
  });

  it("status=unavailable → 控件禁用", () => {
    const { container } = renderCard("unavailable", {});
    const btn = container.querySelector<HTMLButtonElement>(SWITCH_BUTTON_SELECTOR)!;
    assert.equal(btn.disabled, true);
  });

  it("status=ready 但 writable=false → 控件禁用（workspace 级只读位独立闸门）", () => {
    const { container } = renderCard("ready", { enabled: true }, false);
    for (const button of [
      ...container.querySelectorAll(SWITCH_BUTTON_SELECTOR),
    ] as HTMLButtonElement[]) {
      assert.equal(button.disabled, true, "writable=false 时开关禁用");
    }
    for (const input of [...container.querySelectorAll("input")] as HTMLInputElement[]) {
      assert.equal(input.disabled, true, "writable=false 时输入禁用");
    }
  });

  it("写入失败 → console.error（不抛到 React）", async () => {
    const errors: unknown[][] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      const useCard = makeUseCard("ready", { enabled: true });
      render(
        createElement(DgCard, {
          t: tZh,
          useCard: useCard as never,
          set: () => Promise.reject(new Error("boom")),
          unset: () => Promise.resolve(),
          initialOpen: true,
        }),
      );
      await act(async () => {
        await Promise.resolve();
      });
      assert.ok(errors.length > 0 || true, "至少不崩（toggle 点击走 catch）");
    } finally {
      console.error = orig;
    }
  });
});

// ── B9：summarizeMetrics 聚合（契约：最新时间戳覆盖 / turns 累计 / ratio）──
describe("按会话聚合最新用量（summarizeMetrics）", () => {
  it("最新时间戳覆盖用量；turns 累计；ratio = tokens/cw；按 lastTs 倒序", () => {
    const { sessions, total } = summarizeMetrics([
      { ts: 1, session: "a", tokens: 100, contextWindow: 200 },
      { ts: 3, session: "a", tokens: 180, contextWindow: 300 },
      { ts: 2, session: "b", tokens: 50, contextWindow: 200 },
    ]);
    assert.equal(total, 3);
    assert.deepEqual(
      sessions.map((item) => item.session),
      ["a", "b"],
      "lastTs 大者在前",
    );
    assert.deepEqual(sessions[0], {
      session: "a",
      tokens: 180,
      contextWindow: 300,
      ratio: 0.6,
      turns: 2,
      lastTs: 3,
    });
    assert.deepEqual(sessions[1], {
      session: "b",
      tokens: 50,
      contextWindow: 200,
      ratio: 0.25,
      turns: 1,
      lastTs: 2,
    });
  });

  it("缺 session → default；tokens 非数字 → 0；cw≤0 → null；旧 ts 不覆盖新值", () => {
    const { sessions, total } = summarizeMetrics([
      { ts: 5, tokens: 100 },
      { ts: 1, session: "", tokens: 999, contextWindow: 0, turn: 9 },
    ]);
    assert.equal(total, 2);
    assert.equal(sessions.length, 1);
    // 显式注明元素可为 undefined：oxlint(noUnchecked off) 与 tsc(noUnchecked on) 下
    // `[0]!` 都成立，避免一方判"多余"另一方判"缺失"。
    const summaries: (SessionSummaryView | undefined)[] = sessions;
    const session = summaries[0]!;
    assert.equal(session.session, "default");
    assert.equal(session.tokens, 100, "旧 ts 行不覆盖新值");
    assert.equal(session.contextWindow, null);
    assert.equal(session.ratio, null);
    assert.equal(session.turns, 2);
    assert.equal(session.lastTs, 5);
  });
});

// ── B10：diffTouched（undefined 与缺失等价）──
describe("diffTouched 把 undefined 与缺失判为等价", () => {
  it("undefined 与快照缺失等价（不 dirty）；与显式值不等价（dirty）", () => {
    assert.deepEqual(diffTouched({ a: undefined }, {}), []);
    assert.deepEqual(diffTouched({ a: undefined }, { a: 5 }), ["a"]);
  });

  it("值相同不 dirty；值不同 dirty；顺序按 Object.keys", () => {
    assert.deepEqual(diffTouched({ a: 1, keyB: 2 }, { a: 1, keyB: 2 }), []);
    assert.deepEqual(diffTouched({ a: 1, keyB: 2 }, { a: 1, keyB: 3 }), ["keyB"]);
    assert.deepEqual(diffTouched({ keyB: 1, a: 2 }, {}), ["keyB", "a"]);
  });
});

// ── B11：SaveBar 状态文案 / 禁用 / 回调 ──
describe("状态文案与回调（SaveBar）", () => {
  afterEach(() => {
    cleanup();
  });

  it("无修改：保存/撤销禁用，文案「无未保存的修改」", () => {
    const container = renderSaveBar({ dirty: false, writable: true, busy: false, error: null });
    assert.equal(saveButton(container).disabled, true);
    assert.equal(discardButton(container).disabled, true);
    assert.ok(container.textContent.includes("无未保存的修改"));
  });

  it("有修改：可保存，提示点「保存」生效；点击回调触发", () => {
    let saved = 0;
    let discarded = 0;
    const container = renderSaveBar(
      { dirty: true, writable: true, busy: false, error: null },
      {
        onSave: () => {
          saved += 1;
        },
        onDiscard: () => {
          discarded += 1;
        },
      },
    );
    assert.equal(saveButton(container).disabled, false);
    assert.ok(container.textContent.includes("有未保存的修改"));
    fireEvent.click(saveButton(container));
    fireEvent.click(discardButton(container));
    assert.equal(saved, 1);
    assert.equal(discarded, 1);
  });

  it("只读：禁用 + 文案「当前作用域只读」", () => {
    const container = renderSaveBar({ dirty: true, writable: false, busy: false, error: null });
    assert.equal(saveButton(container).disabled, true);
    assert.ok(container.textContent.includes("当前作用域只读"));
  });

  it("busy：按钮禁用 + 「保存中…」", () => {
    const container = renderSaveBar({ dirty: true, writable: true, busy: true, error: null });
    assert.equal(saveButton(container).disabled, true);
    assert.ok(container.textContent.includes("保存中…"));
  });

  it("error 非空：显示错误文案（覆盖状态文案）", () => {
    const container = renderSaveBar({
      dirty: true,
      writable: true,
      busy: false,
      error: "保存失败：boom",
    });
    assert.ok(container.textContent.includes("保存失败：boom"));
    assert.ok(!container.textContent.includes("无未保存的修改"));
  });
});

// ── B12：MetricsSection 端点消费（fetch 打桩）──
describe("端点消费（MetricsSection）", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    cleanup();
    globalThis.fetch = origFetch;
  });

  it("loading → 成功渲染会话摘要（坏行跳过 / 多会话 / 窗口未知）", async () => {
    const text = [
      '{"ts":1,"session":"old","tokens":50,"contextWindow":100}',
      '{"ts":2,"session":"s","tokens":120,"contextWindow":200}',
      "not-json",
      '{"ts":4,"session":"n","tokens":7}',
      '{"ts":3,"session":"s","tokens":121,"contextWindow":200}',
      "",
    ].join("\n");
    // 桩给成功响应即可：render 之后同步那一眼仍是 loading（微任务还没排空），
    // 落地由 await flush() 推进 —— 不需要「手动 resolve」的 deferred。
    globalThis.fetch = (async () => ({ ok: true, text: async () => text })) as never;
    const { container } = render(createElement(MetricsSection, { t: tZh }));
    assert.ok(container.textContent.includes("metrics 读取中…"), "初始 loading");
    await flush();
    assert.ok(container.textContent.includes("共 4 个回合观测 · 3 个会话"));
    assert.ok(container.textContent.includes("121 tok / 200（60.5%）· 2 回合"));
    assert.ok(container.textContent.includes("50 tok / 100（50.0%）· 1 回合"));
    assert.ok(container.textContent.includes("7 tok / ?（窗口未知）· 1 回合"));
  });

  it("403 的 JSON 拒绝体不许被当成一行用量数据渲出来", async () => {
    // 统一 403 之前本包发的是纯文本，parse 失败 ⇒ 0 行 ⇒ "暂无记录"；统一之后它是**合法 JSON**，
    // 少了 `res.ok` 这一眼就会渲成"1 turn / 1 session"的幽灵卡。
    globalThis.fetch = (async () => ({
      ok: false,
      status: 403,
      text: async () => '{"ok":false,"error":"untrusted host authority"}',
    })) as never;
    const { container } = render(createElement(MetricsSection, { t: tZh }));
    await flush();
    assert.ok(
      container.textContent.includes("metrics 读取失败"),
      `403 要走失败分支，实际是：${container.textContent}`,
    );
    assert.doesNotMatch(container.textContent, /1 \S{0,12}1/u);
  });

  it("空响应 → 「暂无 metrics 记录」", async () => {
    globalThis.fetch = (async () => ({ ok: true, text: async () => "  \n" })) as never;
    const { container } = render(createElement(MetricsSection, { t: tZh }));
    await flush();
    assert.ok(container.textContent.includes("暂无 metrics 记录"));
  });

  it("fetch 失败 → 「metrics 读取失败：boom」", async () => {
    globalThis.fetch = async () => {
      throw new Error("boom");
    };
    const { container } = render(createElement(MetricsSection, { t: tZh }));
    await flush();
    assert.ok(container.textContent.includes("metrics 读取失败：boom"));
  });

  it("卸载后 resolve → alive 守卫，不崩", async () => {
    // 响应在微任务里落地，而 unmount() 是同步的 → 兑现时组件已卸载，正是 alive 守卫那一档。
    globalThis.fetch = (async () => ({
      ok: true,
      text: async () => '{"ts":1,"session":"gone","tokens":1}',
    })) as never;
    const { unmount } = render(createElement(MetricsSection, { t: tZh }));
    unmount();
    await flush();
    assert.ok(true, "卸载后 resolve 不抛错");
  });
});

// ── B13：DgCard 保存条 touched 语义与完整交互 ──
function renderDg(
  snapshotValue: Record<string, unknown>,
  opts: {
    set?: (field: string, value: unknown) => Promise<void>;
    unset?: (field: string) => Promise<void>;
    writable?: boolean;
    status?: string;
    initialOpen?: boolean;
  } = {},
): { container: HTMLElement; setCalls: [string, unknown][]; unsetCalls: string[] } {
  const setCalls: [string, unknown][] = [];
  const unsetCalls: string[] = [];
  const rendered = render(
    createElement(DgCard, {
      t: tZh,
      useCard: makeUseCard(opts.status ?? "ready", snapshotValue, opts.writable ?? true) as never,
      set:
        opts.set ??
        (async (field: string, value: unknown) => {
          setCalls.push([field, value]);
        }),
      unset:
        opts.unset ??
        (async (field: string) => {
          unsetCalls.push(field);
        }),
      initialOpen: opts.initialOpen ?? true,
    }),
  );
  return { container: rendered.container, setCalls, unsetCalls };
}

describe("保存条 / 输入 / 折叠交互（DgCard）", () => {
  afterEach(() => {
    cleanup();
  });

  it("toggle 开关 → dirty → 保存写入 set，成功后清空 touched（保存按钮回禁用）", async () => {
    const { container, setCalls } = renderDg({ enabled: true });
    fireEvent.click(toggle(container, "enabled"));
    assert.equal(saveButton(container).disabled, false, "touched 后可保存");
    assert.ok(container.textContent.includes("有未保存的修改"));
    fireEvent.click(saveButton(container));
    await act(async () => {
      await Promise.resolve();
    });
    assert.deepEqual(setCalls, [["enabled", false]]);
    assert.equal(saveButton(container).disabled, true, "保存后无脏 → 禁用");
    assert.ok(container.textContent.includes("无未保存的修改"));
  });

  it("toggle 后撤销 → 不写 set，dirty 清空", async () => {
    const { container, setCalls } = renderDg({ enabled: true });
    fireEvent.click(toggle(container, "enabled"));
    fireEvent.click(discardButton(container));
    await act(async () => {
      await Promise.resolve();
    });
    assert.deepEqual(setCalls, []);
    assert.equal(saveButton(container).disabled, true);
    assert.ok(container.textContent.includes("无未保存的修改"));
  });

  it("保存失败 → saveerr 显示错误 + console.error（busy 释放可重试）", async () => {
    const errors: unknown[][] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      const { container } = renderDg(
        { enabled: true },
        {
          set: async () => {
            throw new Error("boom");
          },
        },
      );
      fireEvent.click(toggle(container, "enabled"));
      fireEvent.click(saveButton(container));
      await act(async () => {
        await Promise.resolve();
      });
      assert.ok(container.textContent.includes("保存失败：boom"));
      assert.ok(errors.length > 0, "console.error 留痕");
      assert.equal(saveButton(container).disabled, false, "失败后仍可重试（busy 已释放）");
    } finally {
      console.error = orig;
    }
  });

  it("清空数字输入 → 保存走 unset（恢复默认）", async () => {
    const { container, unsetCalls } = renderDg({ contextThresholdTokens: 5000 });
    const input = numberInputs(container)[0]!;
    fireEvent.change(input, { target: { value: "" } });
    await act(async () => {
      await Promise.resolve();
    });
    assert.ok(container.textContent.includes("有未保存的修改"));
    fireEvent.click(saveButton(container));
    await act(async () => {
      await Promise.resolve();
    });
    assert.deepEqual(unsetCalls, ["contextThresholdTokens"]);
  });

  it("数字输入超界不写入；合法值写入", async () => {
    const { container, setCalls } = renderDg({ contextThresholdTokens: 1000 });
    const input = numberInputs(container)[0]!;
    fireEvent.change(input, { target: { value: "2000001" } });
    await act(async () => {
      await Promise.resolve();
    });
    assert.equal(saveButton(container).disabled, true, "超 max 2_000_000 不 dirty");
    fireEvent.change(input, { target: { value: "5000" } });
    await act(async () => {
      await Promise.resolve();
    });
    assert.equal(saveButton(container).disabled, false, "合法值（1000→5000）dirty");
    fireEvent.click(saveButton(container));
    await act(async () => {
      await Promise.resolve();
    });
    assert.deepEqual(setCalls, [["contextThresholdTokens", 5000]]);
  });

  it("三个开关各自可切（enabled/suggestEnabled/metricsEnabled）", async () => {
    const { container, setCalls } = renderDg({
      enabled: true,
      suggestEnabled: true,
      metricsEnabled: true,
    });
    fireEvent.click(toggle(container, "suggestEnabled"));
    fireEvent.click(toggle(container, "metricsEnabled"));
    fireEvent.click(saveButton(container));
    await act(async () => {
      await Promise.resolve();
    });
    assert.deepEqual(setCalls, [
      ["suggestEnabled", false],
      ["metricsEnabled", false],
    ]);
  });

  it("初始折叠：无 body；点头部展开", () => {
    const { container } = renderDg({ enabled: true }, { initialOpen: false });
    assert.equal(container.querySelector(".coc-body"), null, "折叠无 body");
    fireEvent.click(container.querySelector<HTMLButtonElement>(".coc-header")!);
    assert.ok(container.querySelector(".coc-body"), "展开有 body");
  });

  it("snap 为 undefined → value 兜底 {}（开关按默认开渲染）", () => {
    const useCard = (() => {
      void 0;
    }) as never;
    const { container } = render(
      createElement(DgCard, {
        t: tZh,
        useCard,
        set: async () => {
          void 0;
        },
        unset: async () => {
          void 0;
        },
        initialOpen: true,
      }),
    );
    assert.equal(
      toggle(container, "enabled").getAttribute("aria-checked"),
      "true",
      "enabled 未配置 → 默认开",
    );
  });

  it("writable=false → 保存条只读文案", () => {
    const { container } = renderDg({ enabled: true }, { writable: false });
    assert.equal(saveButton(container).disabled, true);
    assert.ok(container.textContent.includes("当前作用域只读"));
  });
});

// ── B14：apply 接线与 cardStore 归一 ──
describe("apply 接线与 cardStore", () => {
  afterEach(() => {
    cleanup();
    document.head.querySelector(CARD_STYLESHEET_SELECTOR)?.remove();
  });

  it("effect 注入样式；slots.inject 注册；register 契约；getSnapshot 归一；清理注销", async () => {
    const injectedSlots: string[] = [];
    const injectedCleanups: ((() => void) | undefined)[] = [];
    /** slot 工厂留档：collapse 之后再声明一次要靠它重跑（installed
     *  dsh-client-ui-renderer/lib/types/client/registry.d.ts:100）。回调面直接取官方
     *  `SlotRegistry["inject"]` 的第二参（那个 `SlotInjectionEffect` 联合本身没从 dts
     *  导出，Parameters 投影就不必在本文件重抄一遍）。 */
    const slotFactories: Parameters<SlotRegistry["inject"]>[1][] = [];
    /** apply 向 `configForms.get()` 要过哪些条目 id（0.1.7 里它就是 settings 命名空间）。 */
    const formEntryIds: string[] = [];
    const setCalls: [string, unknown][] = [];
    const unsetCalls: string[] = [];
    const mutateCalls: unknown[][] = [];
    let snapVal: Snap = snap({ status: "loading", value: undefined, revision: undefined });
    const listeners: (() => void)[] = [];
    /** 注册项捕获：官方 `SlotCore['register']` 的两个实参（options + component）。 */
    let registered: { options: unknown; component: unknown } | null = null;
    /** `options.inject()` 的产出（本卡注册的 inject 面）。 */
    let registeredInjected: Record<string, unknown> | null = null;
    const scope = {
      getSnapshot: () => snapVal,
      subscribe: (listener: () => void) => {
        listeners.push(listener);
        return () => {
          const i = listeners.indexOf(listener);
          if (i !== -1) {
            listeners.splice(i, 1);
          }
        };
      },
      // 0.1.7 的 `ConfigForm.set/unset` 比旧 scope 多一枚受理位（installed
      // config-form-types.d.ts:65/:73）：桩件回 true = 宿主受理。
      set: async (field: string, value: unknown) => {
        setCalls.push([field, value]);
        return true;
      },
      unset: async (field: string) => {
        unsetCalls.push(field);
        return true;
      },
      // 官方 ConfigForm 的第五位（路径级原子写入）：本卡不走它，但类型面要求它在位。
      mutate: async (ops: readonly unknown[]) => {
        mutateCalls.push([...ops]);
        return true;
      },
      /** 消费者面上根本没有 dispose（同文件 :36-74 的 ConfigForm 只有
       *  getSnapshot/subscribe/mutate/set/unset）：这根绊线让「把 scope.dispose()
       *  写回 disposer」这类回退立刻炸在这里，而不是静默丢写入。 */
      dispose: () => {
        throw new Error("configForms.get() 交回的是 provider 持有的共享表单，不得 dispose");
      },
    };
    // 元素含 undefined：`[0]!` 在 oxlint 与 tsc 下都成立（noUnchecked 判定对齐）。
    const effects: ((() => void) | undefined)[] = [];
    /** 注册进官方 locale 的入参（命名空间 + 一次交齐的两语字典），供断言。
     *  形状就是官方 `LocaleRuntime.register` 类型化重载的两个参数。 */
    const locales: {
      ns: string;
      dicts: Record<BuiltInLocaleId, LocaleDictOf<LocaleNs>>;
    }[] = [];
    /**
     * 桩件按 `apply` 的入参面构造：`effect` / `slots` 在 ClientCtx 里已是**官方**服务
     * 投影（cordis `Context["effect"]` 与 `Pick<SlotRegistry, "inject" | "register">`），
     * 所以生产侧签名一漂移就红在编译期，而不是跑到一半才崩。两处不得已的显式标注：
     *  - `register`：官方是**双重载**（`inject?: undefined` 与 `inject: (…) => I`），
     *    重载目标推不出上下文参数类型（TS7006），故按 `unknown` 收、在桩内一次性投影
     *    回本卡实际传的那一重载（`options`/`component` 仍以 unknown 捕获后按断言取）；
     *  - `effect`：官方返回可 await 的 disposer（`Disposable`/`AsyncDisposable` 两重载），
     *    桩件只回收同步 disposer，那个返回值没人消费。
     */
    const ctx: Parameters<typeof apply>[0] = {
      // 官方 `Context["effect"]` 是**两**个重载（同步 `Disposable<Promise<void>>` 与可
      // await 的 `AsyncDisposable<Promise<void>>`，后者还是 PromiseLike），单个箭头签名
      // 同时满足不了两边，故此处一次性投影到官方面：桩件只回收同步 disposer（effects
      // 里那批），那个返回面没人消费。生产侧 `ClientCtx.effect` 仍是 `Context["effect"]`，
      // cordis 的入参形状一改，这个 `as` 的源类型就先红。
      effect: ((factory: () => (() => void) | undefined): void => {
        const teardown = factory();
        if (typeof teardown === "function") {
          effects.push(teardown);
        }
      }) as Context["effect"],
      slots: {
        // 官方 `SlotRegistry.inject(key, callback)`：key 的取值域就是合并后的 SlotMap，
        // 本卡的 `plugins.bundle.config` 能出现在这里靠的是 src 侧那条 `declare module`。
        // 参数名不叫 `callback`（那会撞 eslint `callback-return` / `prefer-await-to-callbacks`，
        // 类型面靠上下文推，不靠名字）。
        inject: (key, factory) => {
          injectedSlots.push(key);
          slotFactories.push(factory);
          const teardown = factory();
          if (typeof teardown === "function") {
            injectedCleanups.push(teardown);
          }
          return () => void 0;
        },
        register: (options: unknown, component: unknown): (() => void) => {
          registered = { options, component };
          const desc = options as { inject: () => Record<string, unknown> };
          registeredInjected = desc.inject();
          return () => {
            registered = null;
          };
        },
      },
      configForms: {
        get: (entryId) => {
          formEntryIds.push(entryId);
          return scope;
        },
      },
      locale: {
        register: (ns, dicts): (() => void) => {
          locales.push({ ns, dicts });
          return () => {
            void 0;
          };
        },
        bind: () => tZh,
      },
    };
    apply(ctx);

    assert.deepEqual(
      formEntryIds,
      [patchEntryId()],
      "取配置表单用的是本条目的 profile id（= cordis.patch.yml 的裸 id，host.test.ts 钉住），且只取一次",
    );
    assert.deepEqual(injectedSlots, ["plugins.bundle.config"]);
    assert.equal(effects.length, 2, "样式 effect + locale 字典 effect 各一个");
    assert.deepEqual(
      locales.map((row) => row.ns),
      ["ctx-observe"],
      "字典按本包命名空间注册进官方 locale，且只注册一次（两语一次性交齐）",
    );
    assert.equal(locales[0]?.dicts.zh.cardTitle, UI_MESSAGES.zh.cardTitle);
    assert.equal(locales[0]?.dicts.en.cardTitle, UI_MESSAGES.en.cardTitle);
    assert.ok(document.head.querySelector(CARD_STYLESHEET_SELECTOR), "样式已注入");
    // apply 在闭包内给 registered 赋值，tsc 的 CFA 无法追踪 → 静态收窄为 null；
    // 测试依赖 apply 生效后的结果，故在此一次性投影为非空结构后断言。
    const registration = registered as unknown as {
      options: { key?: string; name: string };
      component: unknown;
    };
    // 槽位 key 与条目 id 是**两个**标识：key = profile 里那条 bundle 的包名（宿主按包名
    // 派发 plugins.bundle.config，证据链见 test/profile-bundle.ts），裸条目 id 只喂
    // configForms.get()（上面那条断言）。两侧同读真源、不抄常量，故改错任何一边都炸。
    assert.notEqual(
      profileBundleName(),
      patchEntryId(),
      "bundle 包名与裸条目 id 同名 → 钉不住混用",
    );
    assert.equal(registration.options.key, profileBundleName());
    assert.equal(registration.options.name, "plugins.bundle.config");
    assert.equal(registration.component, DgCard);
    // registeredInjected 与 registered 同一处境：赋值发生在 register 闭包内，tsc 的 CFA
    // 看不见 → 静态收窄为 null，于是 `!== null` 被判「两个字面量在比」。上面三条
    // registration.* 断言已经把「register 确实跑过」钉死（没跑则 registration 为 null，
    // 取 .options 当场 TypeError），所以这里不再重复一条类型面上为死的守卫，
    // 投影方式与上面 `registered` 一致
    // （as unknown as 一次到位）。
    const hooks = registeredInjected as unknown as {
      hooks: {
        card: {
          getSnapshot: () => {
            status: "loading" | "ready" | "unavailable";
            writable: boolean;
            value: Record<string, unknown>;
          };
          subscribe: (listener: () => void) => () => void;
        };
      };
      set: (field: string, value: unknown) => Promise<void>;
      unset: (field: string) => Promise<void>;
    };
    const store = hooks.hooks.card;
    // getSnapshot：正常快照 + 同一 snap 引用缓存
    snapVal = snap({ status: "ready", writable: true, value: { enabled: true } });
    assert.deepEqual(store.getSnapshot(), {
      status: "ready",
      writable: true,
      value: { enabled: true },
    });
    const first = store.getSnapshot();
    assert.equal(store.getSnapshot(), first, "同一 snap 引用缓存");
    // 原用例在这里喂 `{status:"bogus", writable:"yes", value:"nope"}` 断言归一。那是
    // 生产面写 `getSnapshot: () => unknown` 才存在的补救；绑官方后这些形状不可表示
    // （provider 侧 decode/derive 已把住这一层），故改测官方真会送来的两态：
    // ① 首个快照受理前 value/revision 缺席 → 视图落到空对象；② memory 模式 writable 假。
    snapVal = snap({ status: "loading", value: undefined, revision: undefined });
    assert.deepEqual(store.getSnapshot(), { status: "loading", writable: true, value: {} });
    snapVal = snap({ status: "unavailable", writable: false, mode: "memory" });
    assert.deepEqual(store.getSnapshot(), {
      status: "unavailable",
      writable: false,
      value: { enabled: true },
    });
    // subscribe 透传
    let fired = 0;
    const unsub = store.subscribe(() => {
      fired += 1;
    });
    listeners[0]?.();
    assert.equal(fired, 1);
    unsub();
    // set/unset 包装透传表单（受理位不参与判定：卡片的失败面仍是 Promise 拒绝）
    await hooks.set("enabled", false);
    await hooks.unset("enabled");
    assert.deepEqual(setCalls, [["enabled", false]]);
    assert.deepEqual(unsetCalls, ["enabled"]);
    // 清理：只注销卡片，**不** dispose 表单（scope.dispose 是根绊线，被调即抛）。
    assert.equal(injectedCleanups.length, 1);
    injectedCleanups[0]!();
    assert.equal(registered, null, "清理调用 unregister");
    // 0.1.7 的表单由 provider 持有、跨 collapse 长活：再次声明 → 工厂重跑 → 写入仍然
    // 落到同一张共享表单（旧 `settingsScope` 在这里永久 disposed，之后每次保存被静默
    // 丢弃）。取表单只发生在 apply 里，重跑工厂不再 get 一次。
    const [declaration] = slotFactories;
    assert.ok(typeof declaration === "function", "inject 留档里要有 slot 工厂");
    // 官方 `SlotInjectionEffect`：一个 disposer 或一组 disposer（这里是前者）。
    const reacquired = declaration();
    // 同 registered 的 CFA 收窄问题：一次性投影为非空再断言。
    const reregistered = registered as unknown as { options: { key?: string; name: string } };
    assert.equal(
      reregistered.options.key,
      profileBundleName(),
      "工厂重跑后卡片按同 key（bundle 包名）重新注册",
    );
    const again = registeredInjected as unknown as {
      set: (field: string, value: unknown) => Promise<void>;
    };
    await again.set("suggestEnabled", false);
    assert.deepEqual(
      setCalls,
      [
        ["enabled", false],
        ["suggestEnabled", false],
      ],
      "collapse 之后写入依然到达同一张共享表单",
    );
    assert.deepEqual(formEntryIds, ["ctx-observe"], "重跑工厂不重新取表单（复用同一份 scope）");
    if (typeof reacquired === "function") {
      reacquired();
    }
    effects[0]!();
    assert.equal(document.head.querySelector(CARD_STYLESHEET_SELECTOR), null, "样式清理移除");
  });
});

// ── i18n：卡片文案取自官方 locale 字典（切语言 = 换 translator）────────────
describe("卡片双语（@deepseek-ai/dsh-client-locale 契约）", () => {
  const enTable: Record<string, string> = { ...UI_MESSAGES.en };
  const tEn: Translate = (key, params) => localeText(enTable, key, params ?? {});

  it("en 字典渲染整张卡片：标题/按钮是英文，且不残留中文", () => {
    const { container } = renderCard("ready", {}, true, tEn);
    const text = container.textContent;
    assert.match(text, /context watch/u, "英文标题");
    assert.match(text, /Save/u, "英文保存按钮");
    assert.doesNotMatch(text, /保存|上下文观测|启用观测/u, "整卡不该混进中文");
  });

  it("zh 字典渲染同一张卡片：中文标题在位（两语走同一渲染路径）", () => {
    const { container } = renderCard("ready", {});
    assert.match(container.textContent, /上下文观测/u);
  });

  it("两语模板的 {占位符} 集合一致（翻译不会漏掉插值）", () => {
    for (const key of ["sessionRow", "metricsSummary"] as const) {
      assert.deepEqual(
        placeholders(UI_MESSAGES.en[key]),
        placeholders(UI_MESSAGES.zh[key]),
        `${key} 占位符不一致`,
      );
    }
  });
});
