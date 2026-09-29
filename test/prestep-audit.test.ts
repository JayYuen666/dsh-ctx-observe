// lib/prestep-audit 单元测试：pre-step 决策形状探测器的判别语义。
// 背景见模块头注释（2026-09-18 UNKNOWN 崩溃取证）。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { findPreStepAnomalies } from "../lib/prestep-audit.ts";

/** 探测器给「enter 缺 messages」这一类的 finding 名（本文件写死的期望值）。 */
const ENTER_WITHOUT_MESSAGES_FINDING = "enter-without-messages";

const makePayload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  agent: { session: { id: "s1" } },
  messages: [],
  turn: 3,
  step: 1,
  ...over,
});

describe("findPreStepAnomalies：健康形状零异常", () => {
  it("enter + messages 数组 → 无异常", () => {
    const out = findPreStepAnomalies("outer", makePayload(), { kind: "enter", messages: [{}] });
    assert.deepEqual(out, []);
  });

  it("reject 哨兵不带 messages → 合法，无异常", () => {
    assert.deepEqual(findPreStepAnomalies("inner", makePayload(), { kind: "reject" }), []);
  });

  it("enter 带额外字段（startsRequestSeries/assembly）→ 只看 messages", () => {
    const out = findPreStepAnomalies("outer", makePayload(), {
      kind: "enter",
      messages: [],
      startsRequestSeries: true,
    });
    assert.deepEqual(out, []);
  });
});

describe("findPreStepAnomalies：异常形状逐类命中", () => {
  it("enter 缺 messages（本次崩溃指纹）→ enter-without-messages + msgsType=undefined", () => {
    const out = findPreStepAnomalies("outer", makePayload(), { kind: "enter" });
    assert.equal(out.length, 1);
    assert.equal(out.at(0)?.finding, ENTER_WITHOUT_MESSAGES_FINDING);
    assert.equal(out.at(0)?.msgsType, "undefined");
    assert.equal(out.at(0)?.tag, "outer");
    assert.equal(out.at(0)?.turn, 3);
    assert.equal(out.at(0)?.sid, "s1");
  });

  it("messages 非数组（null/对象/字符串）→ 同类命中且带 typeof", () => {
    const cases: readonly (readonly [string, unknown])[] = [
      ["null", null],
      ["object", {}],
      ["string", "x"],
    ];
    for (const [label, badValue] of cases) {
      const out = findPreStepAnomalies("inner", makePayload(), {
        kind: "enter",
        messages: badValue,
      });
      assert.equal(out.length, 1, label);
      assert.equal(out.at(0)?.finding, ENTER_WITHOUT_MESSAGES_FINDING);
      assert.equal(out.at(0)?.msgsType, typeof badValue);
    }
  });

  it("decision 非对象（undefined/字符串/数字）→ decision-nonrecord", () => {
    const cases: readonly (readonly [string, unknown])[] = [
      ["undefined", undefined],
      ["string", "oops"],
      ["number", 42],
    ];
    for (const [label, badValue] of cases) {
      const out = findPreStepAnomalies("outer", makePayload(), badValue);
      assert.equal(out.length, 1, label);
      assert.equal(out.at(0)?.finding, "decision-nonrecord");
      assert.equal(out.at(0)?.msgsType, typeof badValue);
    }
  });

  it("decision 有 messages 但缺 kind → missing-kind（消费侧先读 kind 的形态）", () => {
    const out = findPreStepAnomalies("outer", makePayload(), { messages: [] });
    assert.equal(out.length, 1);
    assert.equal(out.at(0)?.finding, "missing-kind");
    assert.deepEqual(out.at(0)?.keys, ["messages"]);
  });

  it("payload.messages 非数组 → payload-anomaly（根/inbox 侧坏形的最上游观测点）", () => {
    const out = findPreStepAnomalies("inner", makePayload({ messages: undefined }), {
      kind: "enter",
      messages: [],
    });
    assert.equal(out.length, 1);
    assert.equal(out.at(0)?.finding, "payload-anomaly");
  });

  it("payload 与 decision 双坏 → 两条都记（不短路）", () => {
    const out = findPreStepAnomalies("outer", makePayload({ messages: null }), { kind: "enter" });
    assert.equal(out.length, 2);
    assert.deepEqual(
      out.map((finding) => finding.finding),
      ["payload-anomaly", ENTER_WITHOUT_MESSAGES_FINDING],
    );
  });
});

describe("findPreStepAnomalies：健壮性与隐私", () => {
  it("payload 结构残缺（无 agent/session）→ 不抛，摘要字段缺省", () => {
    const out = findPreStepAnomalies("outer", {}, { kind: "enter" });
    // payload-anomaly + enter-without-messages 双条
    assert.equal(out.length, 2);
    assert.equal(out.at(0)?.sid, undefined);
    assert.equal(out.at(0)?.turn, undefined);
  });

  it("绝不序列化消息正文（行内只含元数据键）", () => {
    const secret = "SENSITIVE-CONTENT-SHOULD-NOT-APPEAR";
    const out = findPreStepAnomalies("outer", makePayload({ messages: [{ id: secret }] }), {
      kind: "enter",
    });
    const line = JSON.stringify(out);
    assert.ok(!line.includes(secret), "审计行不得含消息内容");
  });

  it("纯函数：输入对象不被修改", () => {
    const inputPayload = makePayload();
    const inputDecision: Record<string, unknown> = { kind: "enter" };
    const beforePayload = JSON.stringify(inputPayload);
    const beforeDecision = JSON.stringify(inputDecision);
    findPreStepAnomalies("outer", inputPayload, inputDecision);
    assert.equal(JSON.stringify(inputPayload), beforePayload);
    assert.equal(JSON.stringify(inputDecision), beforeDecision);
  });
});
