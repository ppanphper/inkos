import type { Message, MessageRequestStatus, RewindPlan, RewindTarget } from "./types";

// 用户消息显示时会在正文后附上附件清单（见 formatUserMessageForDisplay 与服务端
// 恢复逻辑），编辑时只取正文。
const ATTACHMENT_SUMMARY = /\n\n(?:附件：|Attachments:)\n- [\s\S]*$/;

export function rewindTargetForMessage(message: Message): RewindTarget | null {
  if (message.role !== "user") return null;
  if (message.requestId) return { requestId: message.requestId };
  if (message.clientRequestId) return { clientRequestId: message.clientRequestId };
  return null;
}

export function editableMessageText(message: Message): string {
  return message.editText ?? message.content.replace(ATTACHMENT_SUMMARY, "");
}

/** Whether the model never received this message as part of the conversation. */
export function isOutsideConversation(message: Message, sessionBusy: boolean): boolean {
  return message.requestStatus === "failed" || (message.requestStatus === "pending" && !sessionBusy);
}

/**
 * Editing one turn that changed no files needs no extra step: the edit bar
 * already says the message will be replaced. Everything else is confirmed.
 */
export function rewindNeedsConfirmation(
  plan: RewindPlan,
  mode: "edit" | "retract",
  requestStatus?: MessageRequestStatus,
): boolean {
  if (plan.turnCount > 1) return true;
  if (plan.work.status === "available" || plan.work.status === "unavailable") return true;
  // 本页发出的消息在完成后没有服务端状态，按已完成处理。
  return mode === "retract" && (requestStatus === "committed" || requestStatus === undefined);
}
