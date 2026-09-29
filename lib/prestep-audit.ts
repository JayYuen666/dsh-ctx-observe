/**
 * prestep-audit —— agent/pre-step 决策形状探测器（纯函数，零 IO）。
 *
 * 背景：多会话多 provider 间歇性出现回合失败
 * `Cannot read properties of undefined (reading 'length')` code=UNKNOWN，
 * 崩溃边界全部落在 pre-step waterfall 的消费侧（core agent.ts:295/298 与
 * dsh-agent model-selection.ts:114 读 decision.messages.length；官方根生产者
 * 恒带 messages）。静态审查已排除本 profile 全部已启用参与者的常规分支——
 * 嫌疑收敛为特定数据触发的畸形决策形状或宿主内部竞态。本探测器的职责：
 *
 *   1. 在瀑布的内层（append 注册）与外层（prepend 注册）各验一次下游返回值，
 *      只记录不改动（passthrough 语义逐字保持），异常落盘供事后归因。
 *   2. 判别矩阵：outer 异常+inner 正常 → 产者位于两探针之间的其他 prepend
 *      参与者（model-selection / session-reference / goal-round-driver /
 *      auto-recall…）；双层同异常 → 产者在根/inbox 侧；双层皆净而仍崩 →
 *      消费侧自身竞态，指向宿主。
 *
 * 形状契约（@deepseek-ai/dsh-tool-cordis api-catalog 'agent/pre-step'）：
 *   PreStepDecision = { kind:'reject' } | { kind:'enter', messages: UserMessage[], ...rest }
 *   payload        = { agent, messages: UserMessage[], turn, step, signal }
 */

/** 单条审计发现（序列化后即落盘行；不含消息正文，防泄漏与膨胀）。 */
import { fieldOf, isRecord } from "@jayyuen666/dsh-plugin-shared/lib/record";

export interface AuditFinding {
  /** 探针位置标签。 */
  tag: string;
  /** 异常种类。 */
  finding: "decision-nonrecord" | "missing-kind" | "enter-without-messages" | "payload-anomaly";
  /** 决策 kind（可缺）。 */
  kind?: string;
  /** decision.messages 的 typeof（异常定位核心字段）。 */
  msgsType?: string;
  /** messages 长度（仅当确为数组）。 */
  msgsLen?: number;
  /** 决策对象自身键名前 12 个（诊断产者指纹用）。 */
  keys?: string[];
  /** payload.turn / payload.step（若可得）。 */
  turn?: number;
  step?: number;
  /** 会话 id（若可得，用于跨会话聚簇）。 */
  sid?: string;
}

/** 从 payload 提取会话 id（保守读法，结构缺失一律 undefined 不抛）。 */
function sidOf(payload: unknown): string | undefined {
  const session = fieldOf(fieldOf(payload, "agent"), "session");
  const id = fieldOf(session, "id");
  return typeof id === "string" ? id : undefined;
}

/** 数字字段窄化（turn/step 仅收 number，其余 undefined）。 */
function numOf(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/** 决策对象的浅诊断摘要（绝不触碰消息内容）。入参已由调用方窄化为 Record——
 *  这里不再二次守卫非对象（那是死分支，只会稀释覆盖率）。 */
function summarize(
  decision: Record<string, unknown>,
): Pick<AuditFinding, "kind" | "msgsType" | "msgsLen" | "keys"> {
  const { kind: kindRaw, messages } = decision;
  return {
    ...(typeof kindRaw === "string" ? { kind: kindRaw } : {}),
    msgsType: typeof messages,
    ...(Array.isArray(messages) ? { msgsLen: messages.length } : {}),
    keys: Object.keys(decision).slice(0, 12),
  };
}

/**
 * 检查一对 (payload, decision)，返回 0..n 条异常（正常 → 空数组）。
 * 纯函数：不抛错、不改输入、无副作用——调用方负责落盘。
 */
export function findPreStepAnomalies(
  tag: string,
  payload: unknown,
  decision: unknown,
): AuditFinding[] {
  const turn = numOf(fieldOf(payload, "turn"));
  const step = numOf(fieldOf(payload, "step"));
  const sid = sidOf(payload);
  const base = {
    tag,
    ...(turn === undefined ? {} : { turn }),
    ...(step === undefined ? {} : { step }),
    ...(sid === undefined ? {} : { sid }),
  };
  const findings: AuditFinding[] = [];
  // payload 侧：messages 非数组意味着根生产/inbox claim 已经产出坏形状——
  // 任何下游 .length 消费都会炸，这是最上游的可观测点。
  if (!Array.isArray(fieldOf(payload, "messages"))) {
    findings.push({
      ...base,
      finding: "payload-anomaly",
      msgsType: typeof fieldOf(payload, "messages"),
    });
  }
  // decision 侧
  if (!isRecord(decision)) {
    findings.push({ ...base, finding: "decision-nonrecord", msgsType: typeof decision });
    return findings;
  }
  const kind = fieldOf(decision, "kind");
  if (typeof kind !== "string") {
    findings.push({ ...base, ...summarize(decision), finding: "missing-kind" });
    return findings;
  }
  if (kind === "reject") {
    // reject 哨兵合法不带 messages
    return findings;
  }
  if (!Array.isArray(fieldOf(decision, "messages"))) {
    findings.push({ ...base, ...summarize(decision), finding: "enter-without-messages" });
  }
  return findings;
}
