// lib/messages.ts —— host 半文案字典（中英双语）。
//
// 只管 host 半：设置卡的 UI 文案走官方 @deepseek-ai/dsh-client-locale
// （client 侧 `ctx.locale.register(ns, locale, dict)` + `bind`/`t`，见 src/client-entry.ts）。
// host 侧没有官方 i18n 面，注入给模型的文本只能自带字典；语言取官方
// settings 的 `locale.preference`（shared 的 resolveLocalePreference），未注册即中文。
//
// 键集一致由 tsc 保证：zh / en 两份都标注同一个 Messages 类型，少键多键都在编译期红。
// console.* 的日志文案不在此列——那是给排障的人看的，不随界面语言切换。
import type { MessagesCatalog } from "@jayyuen666/dsh-plugin-shared/lib/locale";

/** 本包 host 侧产出的全部人读文案。 */
export interface CtxObserveMessages {
  /** 注入给模型的战略压缩建议正文（pre-step waterfall 的 user message）。 */
  readonly remindText: string;
}

export const MESSAGES: MessagesCatalog<CtxObserveMessages> = {
  zh: {
    remindText:
      "[ctx-observe] 上下文用量已接近阈值。建议现在做一个检查点：\n" +
      "1) 把当前进展与结论写入文件（任务清单/笔记），使压缩后可续；\n" +
      "2) 若处于阶段边界（探索完成/里程碑完成），优先在此处压缩，" +
      "避免 auto-compact 在任务中段任意截断。\n" +
      "这是建议而非强制——由你判断当前是否是合适的压缩点。",
  },
  en: {
    remindText:
      "[ctx-observe] Context usage is approaching the threshold. Take a checkpoint now:\n" +
      "1) Write the current progress and conclusions to a file (task list / notes) so the work " +
      "can resume after compaction;\n" +
      "2) If you are at a phase boundary (exploration done, milestone shipped), compact there " +
      "instead of letting auto-compact cut into the middle of a task.\n" +
      "This is a suggestion, not a mandate — you decide whether now is the right moment.",
  },
};
