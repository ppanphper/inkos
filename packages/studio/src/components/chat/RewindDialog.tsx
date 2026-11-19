import type { RewindPlan } from "../../store/chat/types";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";

const MAX_LISTED_FILES = 8;

export interface RewindDialogProps {
  readonly open: boolean;
  readonly isZh: boolean;
  readonly mode: "edit" | "retract";
  readonly plan: RewindPlan | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onConfirm: (restoreWork: boolean) => void;
  readonly onCancel: () => void;
}

function unavailableReason(plan: RewindPlan, isZh: boolean): string | null {
  if (plan.work.status !== "unavailable") return null;
  switch (plan.work.reason) {
    case "NO_CHECKPOINT":
      return isZh
        ? "这几轮没有记录作品快照，只能撤回对话，作品文件保持不变。"
        : "These turns have no work snapshot. Only the conversation can be rewound; work files stay as they are.";
    case "EXTERNAL_CHANGE":
      return isZh
        ? "作品在这几轮期间或之后被其他会话或手动改过，无法安全回退文件。只能撤回对话，作品文件保持不变。"
        : "The work was changed elsewhere during or after these turns, so files cannot be restored safely. Only the conversation can be rewound; work files stay as they are.";
    case "WORK_CHANGED":
      return isZh
        ? "这几轮切换或新建了作品，只能撤回对话，作品文件保持不变。"
        : "These turns switched or created a work. Only the conversation can be rewound; work files stay as they are.";
    case "SNAPSHOT_MISSING":
      return isZh
        ? "部分文件缺少可恢复的版本，只能撤回对话，作品文件保持不变。"
        : "Some files have no restorable version. Only the conversation can be rewound; work files stay as they are.";
  }
}

export function RewindDialog({ open, isZh, mode, plan, busy, error, onConfirm, onCancel }: RewindDialogProps) {
  const later = plan ? plan.turnCount - 1 : 0;
  const scope = isZh
    ? later > 0 ? `这条消息及之后的 ${later} 条消息和回复都会撤回。` : "这条消息和它的回复会撤回。"
    : later > 0 ? `This message and the ${later} after it, with their replies, will be rewound.` : "This message and its reply will be rewound.";
  const changes = plan?.work.status === "available" ? plan.work.changes : [];
  const reason = plan ? unavailableReason(plan, isZh) : null;
  const unavailablePaths = plan?.work.status === "unavailable" ? plan.work.paths ?? [] : [];
  const listed = changes.length > 0 ? changes.map((change) => ({
    key: change.path,
    label: `${isZh
      ? { restore: "还原", create: "恢复", delete: "删除" }[change.action]
      : { restore: "Restore", create: "Recreate", delete: "Delete" }[change.action]} ${change.path}`,
  })) : unavailablePaths.map((path) => ({ key: path, label: path }));
  const send = mode === "edit";
  const primaryLabel = changes.length > 0
    ? send ? (isZh ? "回退文件并发送" : "Restore files and send") : (isZh ? "对话和文件一起回退" : "Rewind conversation and files")
    : reason
      ? send ? (isZh ? "只撤回对话并发送" : "Rewind conversation and send") : (isZh ? "只撤回对话" : "Rewind conversation only")
      : send ? (isZh ? "撤回并发送" : "Rewind and send") : (isZh ? "撤回" : "Rewind");
  const conversationOnlyLabel = send
    ? (isZh ? "只回退对话并发送" : "Conversation only, then send")
    : (isZh ? "只回退对话" : "Conversation only");

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onCancel(); }}>
      <DialogContent showCloseButton={false} className="sm:max-w-[420px] p-4 gap-3">
        <DialogHeader className="gap-1">
          <DialogTitle className="font-sans text-sm font-medium">
            {mode === "edit" ? (isZh ? "替换这条消息" : "Replace this message") : (isZh ? "撤回消息" : "Rewind message")}
          </DialogTitle>
          <DialogDescription className="leading-6">{scope}</DialogDescription>
        </DialogHeader>
        {changes.length > 0 ? (
          <p className="text-sm leading-6 text-foreground">
            {isZh ? "作品文件会回到这条消息发送前：" : "Work files return to how they were before this message:"}
          </p>
        ) : reason ? (
          <p className="text-sm leading-6 text-foreground">{reason}</p>
        ) : null}
        {listed.length > 0 ? (
          <ul className="max-h-40 overflow-y-auto rounded-md border border-border/50 bg-secondary/30 px-3 py-2 font-mono text-xs leading-6 text-muted-foreground">
            {listed.slice(0, MAX_LISTED_FILES).map((item) => <li key={item.key} className="truncate" title={item.label}>{item.label}</li>)}
            {listed.length > MAX_LISTED_FILES ? (
              <li>{isZh ? `另有 ${listed.length - MAX_LISTED_FILES} 个文件` : `${listed.length - MAX_LISTED_FILES} more files`}</li>
            ) : null}
          </ul>
        ) : null}
        {error ? <p role="alert" className="text-sm leading-6 text-destructive">{error}</p> : null}
        <DialogFooter className="gap-1 sm:gap-1">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-30"
          >
            {isZh ? "取消" : "Cancel"}
          </button>
          {changes.length > 0 ? (
            <button
              type="button"
              onClick={() => onConfirm(false)}
              disabled={busy}
              className="px-3 py-1 text-xs rounded-md border border-border/60 text-foreground hover:bg-secondary transition-colors disabled:opacity-30"
            >
              {conversationOnlyLabel}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => onConfirm(changes.length > 0)}
            disabled={busy || !plan}
            className="px-3 py-1 text-xs font-medium rounded-md bg-foreground text-background hover:opacity-90 transition-opacity disabled:opacity-30"
          >
            {primaryLabel}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
