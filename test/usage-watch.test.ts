// lib/usage-watch 单元测试：上下文压力判定 + 战略压缩建议时机。
// 移植自 ECC suggest-compact（MIT）：主信号 usage tokens，辅信号工具调用计数。
//
// observe() 返回"提案"（text + commit）：判定当场成立、
// 提醒名额要等调用方真的注入后才消费。本文件的提醒序列断言因此成对出现
// ——先 observe()、再 commit()，等价旧实现里"返回文本即已消费"的那一步。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { UsageWatch } from "../lib/usage-watch.ts";
import { MESSAGES } from "../lib/messages.ts";

/** 判定并立即消费名额（模拟注入成立后的 host 行为）。 */
function remind(watch: UsageWatch, toolCount: number, tokens: number | undefined): boolean {
  const proposal = watch.observe(toolCount, tokens);
  if (proposal === undefined) {
    return false;
  }
  proposal.commit();
  return true;
}

describe("UsageWatch：建议文案（host 侧双语，见 lib/messages.ts）", () => {
  it("未设文案时用中文默认（独立 new 也要有可读建议，不能是空串）", () => {
    const watch = new UsageWatch({ contextThresholdTokens: 100 });
    assert.equal(watch.observe(1, 200)?.text, MESSAGES.zh.remindText);
  });

  it("setRemindText 后，主信号与辅信号两条提案路径都用新串", () => {
    const byTokens = new UsageWatch({ contextThresholdTokens: 100 });
    byTokens.setRemindText("tokens text");
    assert.equal(byTokens.observe(1, 200)?.text, "tokens text");

    const byTools = new UsageWatch({ toolCountFirst: 1 });
    byTools.setRemindText("tools text");
    assert.equal(byTools.observe(3, undefined)?.text, "tools text");
  });

  it("两语文案的键集由 tsc 保证，zh/en 都非空且不同语言", () => {
    assert.notEqual(MESSAGES.zh.remindText, "");
    assert.notEqual(MESSAGES.en.remindText, "");
    assert.notEqual(MESSAGES.zh.remindText, MESSAGES.en.remindText);
  });
});

describe("UsageWatch：阈值判定（主信号 tokens）", () => {
  it("用量未达阈值 → 不建议压缩", () => {
    const watch = new UsageWatch({ contextThresholdTokens: 160_000 });
    assert.equal(watch.observe(1, 10_000), undefined);
    assert.equal(watch.observe(1, 159_999), undefined);
  });

  it("用量达阈值 → 建议压缩，消息含指引", () => {
    const watch = new UsageWatch({ contextThresholdTokens: 160_000 });
    const result = watch.observe(1, 160_000);
    assert.ok(Boolean(result));
    assert.match(result?.text ?? "", /压缩|compact/iu);
  });

  it("跨过阈值后不重复提醒，直到再增长 interval", () => {
    const watch = new UsageWatch({ contextThresholdTokens: 160_000, remindIntervalTokens: 60_000 });
    // 首次
    assert.equal(remind(watch, 1, 160_000), true);
    // 阈值内小增长不重复
    assert.equal(watch.observe(2, 170_000), undefined);
    // 越过 160k+60k 再提醒
    assert.equal(remind(watch, 3, 220_000), true);
  });

  it("fallbackWindow 选项（假定窗 × ratio）生效；非法值回落内置默认", () => {
    // 假定窗 64k × 0.7 = 44_800 兜底阈值：55k（> 44_800，< 旧默认 89_600）即提案。
    const small = new UsageWatch({ fallbackWindow: 64_000 });
    assert.ok(Boolean(small.observe(1, 55_000)), "兜底阈值随假定窗走");
    // 非法（0/负/非有限）→ 回落 FALLBACK_WINDOW（128k × 0.7 = 89_600）。
    for (const bad of [0, -1000, Number.NaN]) {
      const fallback = new UsageWatch({ fallbackWindow: bad });
      assert.equal(fallback.observe(1, 55_000), undefined, "55k 低于内置兜底阈值");
      assert.ok(Boolean(fallback.observe(1, 95_000)), "95k 越过内置兜底阈值");
    }
  });

  it("用量回落（压缩后）→ 重新武装提醒", () => {
    const watch = new UsageWatch({ contextThresholdTokens: 160_000, remindIntervalTokens: 60_000 });
    remind(watch, 1, 200_000);
    // 压缩后回落
    assert.equal(watch.observe(2, 50_000), undefined);
    assert.equal(remind(watch, 3, 170_000), true, "回落后再超阈值应再提醒");
  });
});

// ── 审计 item 1：提案不注入就不消费提醒名额 ──────────────────────────────
describe("UsageWatch：判定与消费分离（RemindProposal.commit）", () => {
  it("只 observe 不 commit → 下一个 step 同水位仍提案（名额未被偷吃）", () => {
    const watch = new UsageWatch({ contextThresholdTokens: 160_000, remindIntervalTokens: 60_000 });
    const first = watch.observe(1, 200_000);
    assert.ok(first, "首过阈值应提案");
    // 未 commit：等价于建议被下游 reject 丢掉，模型根本没看到
    const second = watch.observe(2, 200_000);
    assert.ok(second, "未注入的提案不得消费名额，同水位应再提案");
    second.commit();
    assert.equal(watch.observe(3, 210_000), undefined, "commit 后进入间隔静默");
  });

  it("辅信号同样只在 commit 后消费（工具计数不涨则反复提案）", () => {
    const watch = new UsageWatch({ toolCountFirst: 50, toolCountInterval: 25 });
    assert.ok(watch.observe(50, undefined));
    assert.ok(watch.observe(50, undefined), "未 commit → 仍提案");
    watch.observe(50, undefined)?.commit();
    assert.equal(watch.observe(60, undefined), undefined, "commit 后 10 次增量不足间隔");
  });

  it("回落重武装当场生效（不推迟到 commit）：压缩后重新爬到旧水位仍会提醒", () => {
    const watch = new UsageWatch({ contextThresholdTokens: 700_000, remindIntervalTokens: 50_000 });
    watch.observe(1, 700_000)?.commit();
    // 压缩后跌到 100k，未触发任何提案（无需 commit）→ 名额必须已释放
    assert.equal(watch.observe(2, 100_000), undefined);
    assert.ok(watch.observe(3, 710_000), "710k 距旧提醒点仅 10k，但回落已重武装");
  });

  it("commit 幂等：重复调用只是重写同一水位", () => {
    const watch = new UsageWatch({ contextThresholdTokens: 100, remindIntervalTokens: 10 });
    const proposal = watch.observe(7, 100);
    proposal?.commit();
    proposal?.commit();
    assert.equal(watch.observe(7, 105), undefined, "水位仍按首次提醒点计");
    assert.equal(remind(watch, 8, 110), true);
  });
});

describe("UsageWatch：辅信号（工具调用计数）", () => {
  it("tokens 未知时按工具计数兜底：50 首次提醒", () => {
    const watch = new UsageWatch({ toolCountFirst: 50, toolCountInterval: 25 });
    assert.equal(watch.observe(30, undefined), undefined);
    assert.ok(watch.observe(50, undefined));
  });

  it("工具计数每 25 次再提醒", () => {
    const watch = new UsageWatch({ toolCountFirst: 50, toolCountInterval: 25 });
    remind(watch, 50, undefined);
    assert.equal(watch.observe(60, undefined), undefined);
    assert.ok(watch.observe(75, undefined));
  });
});

describe("UsageWatch：窗口比例触发（contextRatio，默认 70%）", () => {
  it("1M 窗口：699_999 不触发，700_000（70%）触发", () => {
    const watch = new UsageWatch({ contextRatio: 0.7 });
    watch.setWindow(1_000_000);
    assert.equal(watch.observe(1, 699_999), undefined);
    assert.ok(watch.observe(1, 700_000));
  });

  it("1M 窗口：间隔按窗口 5%（50k）——700k 后 730k 不重复、750k 再提醒", () => {
    const watch = new UsageWatch({ contextRatio: 0.7, remindRatio: 0.05 });
    watch.setWindow(1_000_000);
    assert.equal(remind(watch, 1, 700_000), true);
    assert.equal(watch.observe(2, 730_000), undefined);
    assert.equal(remind(watch, 3, 750_000), true);
  });

  it("128k 窗口：89_600（70%）触发——固定 160k 在此窗口永远不触发（隐藏 bug 根因）", () => {
    const watch = new UsageWatch({ contextRatio: 0.7 });
    watch.setWindow(128_000);
    assert.equal(watch.observe(1, 89_599), undefined);
    assert.ok(watch.observe(1, 89_600));
  });

  it("显式绝对阈值 > 窗口比例：900k 覆盖 1M×70%=700k", () => {
    const watch = new UsageWatch({ contextThresholdTokens: 900_000, contextRatio: 0.7 });
    watch.setWindow(1_000_000);
    assert.equal(watch.observe(1, 700_000), undefined);
    assert.ok(watch.observe(1, 900_000));
  });

  it("clearThreshold 撤销绝对阈值 → 回到窗口比例口径（审计 item 6）", () => {
    const watch = new UsageWatch({ contextThresholdTokens: 900_000, contextRatio: 0.7 });
    watch.setWindow(1_000_000);
    assert.equal(watch.observe(1, 700_000), undefined, "绝对阈值 900k 压着 70% 比例");
    watch.clearThreshold();
    assert.ok(watch.observe(1, 700_000), "清空后按 1M×70%=700k 判定");
  });

  it("setThreshold 拒绝非法值（NaN/0/负）→ 保持既有阈值", () => {
    const watch = new UsageWatch({ contextThresholdTokens: 900_000, contextRatio: 0.7 });
    watch.setWindow(1_000_000);
    watch.setThreshold(Number.NaN);
    watch.setThreshold(0);
    watch.setThreshold(-100);
    assert.equal(watch.observe(1, 700_000), undefined, "非法 setThreshold 不覆盖 900k");
    watch.setThreshold(500_000);
    assert.ok(watch.observe(1, 500_000), "合法值即时生效");
  });

  it("setWindow 后按新窗口重新判定", () => {
    const watch = new UsageWatch({ contextRatio: 0.7 });
    watch.setWindow(128_000);
    // 阈值 89_600：80k < 89.6k，未到 70%
    assert.equal(watch.observe(1, 80_000), undefined);
    // 阈值 700_000
    watch.setWindow(1_000_000);
    assert.ok(watch.observe(1, 700_000));
  });

  it("无窗口信息 → 回落兜底阈值 89_600（最小常见窗 128k×0.7；旧 160k 会让 128k 模型永不触发）", () => {
    const watch = new UsageWatch();
    assert.equal(watch.observe(1, 89_599), undefined);
    assert.ok(watch.observe(1, 89_600));
  });
});

describe("UsageWatch：防御式", () => {
  it("非数字输入不抛不提醒", () => {
    const watch = new UsageWatch();
    assert.equal(watch.observe(Number.NaN, undefined), undefined);
    assert.equal(watch.observe(-1, undefined), undefined);
    assert.equal(watch.observe(1, Number.NaN), undefined);
    assert.equal(watch.observe(1, -5), undefined);
  });

  it("setWindow 拒绝非法窗口（NaN/0/负数）→ 保持未知口径", () => {
    const watch = new UsageWatch();
    watch.setWindow(Number.NaN);
    watch.setWindow(0);
    watch.setWindow(-1000);
    assert.equal(watch.window(), null, "非法窗口不写状态");
    watch.setWindow(200_000);
    assert.equal(watch.window(), 200_000);
  });

  it("noteTokens 只记观测值，不做提醒判定", () => {
    const watch = new UsageWatch({ contextThresholdTokens: 100 });
    watch.noteTokens(999_999);
    watch.noteTokens(Number.NaN);
    assert.equal(watch.lastTokens(), 999_999, "非法值不覆盖已记录的用量");
    assert.equal(watch.observe(1, undefined), undefined, "未达 toolCountFirst 不提醒");
  });

  it("reset 清空状态（窗口保留）", () => {
    const watch = new UsageWatch({ contextThresholdTokens: 100 });
    watch.setWindow(128_000);
    remind(watch, 1, 100);
    watch.reset();
    assert.equal(watch.lastTokens(), null, "观测用量清空");
    assert.equal(watch.window(), 128_000, "窗口是会话属性，不随提醒周期重置");
    assert.ok(watch.observe(1, 100), "reset 后同条件重新提案");
  });
});

// ── A3：setRatios 运行时改比例，已建 watcher 生效 ──
describe("setRatios 运行时改比例", () => {
  it("创建后改 contextRatio → 阈值即时更新（1M：0.7→0.5，500k 触发）", () => {
    const watch = new UsageWatch({ contextRatio: 0.7 });
    watch.setWindow(1_000_000);
    assert.equal(watch.observe(1, 500_000), undefined, "0.7 下 500k 不触发");
    watch.setRatios(0.5, undefined);
    assert.ok(watch.observe(2, 500_000), "改 0.5 后 500k 应触发");
  });

  it("改 remindRatio → 重复间隔即时更新", () => {
    const watch = new UsageWatch({ contextRatio: 0.7, remindRatio: 0.05 });
    watch.setWindow(1_000_000);
    assert.equal(remind(watch, 1, 700_000), true, "首过 700k 提醒");
    watch.setRatios(undefined, 0.2);
    assert.equal(watch.observe(2, 750_000), undefined, "间隔改 200k 后 750k 不重复");
    assert.ok(watch.observe(3, 900_000), "900k 距 700k 200k 再提案");
  });

  it("非法值拒绝 0/负/超界/NaN → 保持旧比例", () => {
    const watch = new UsageWatch({ contextRatio: 0.7, remindRatio: 0.05 });
    watch.setWindow(1_000_000);
    watch.setRatios(0, -1);
    watch.setRatios(Number.NaN, 99);
    watch.setRatios(1.5, 0);
    assert.equal(watch.observe(1, 699_999), undefined, "非法 setRatios 后阈值仍是 700k");
    assert.ok(watch.observe(2, 700_000));
  });
});

// ── 构造入参防御（options 全默认路径已在其它用例覆盖）───────────────────
describe("UsageWatch：构造入参", () => {
  it("contextThresholdTokens ≤0 / 缺省 → 视为未配置（走窗口比例）", () => {
    const zero = new UsageWatch({ contextThresholdTokens: 0, contextRatio: 0.7 });
    zero.setWindow(1_000_000);
    assert.ok(zero.observe(1, 700_000), "0 阈值不生效，按 70% 判定");
    const negative = new UsageWatch({ contextThresholdTokens: -5 });
    assert.ok(negative.observe(1, 89_600), "负阈值不生效，按兜底 89_600 判定");
  });

  it("自定义 remindIntervalTokens（无窗口时的辅兜底间隔）", () => {
    const watch = new UsageWatch({
      contextThresholdTokens: 100,
      remindIntervalTokens: 10,
    });
    assert.equal(remind(watch, 1, 100), true);
    assert.equal(watch.observe(2, 105), undefined, "5 < 10 间隔不重复");
    assert.equal(remind(watch, 3, 110), true);
  });
});
