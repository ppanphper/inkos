import { useEffect, useMemo, useState } from "react";
import { MessageSquare, Network, Sparkles } from "lucide-react";
import { fetchJson } from "../hooks/use-api";

interface PlayWorld {
  readonly id: string;
  readonly title: string;
  readonly premise: string;
  readonly mode: "open" | "guided";
  readonly updatedAt: string;
}

interface PlayRunSummary {
  readonly id: string;
  readonly updatedAt: string;
  readonly eventCount: number;
  readonly transcriptCount: number;
}

interface PlayEntity {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly summary?: string;
  readonly status?: string;
}

interface PlayEdge {
  readonly id: string;
  readonly fromId: string;
  readonly type: string;
  readonly toId: string;
}

interface PlayStateSlot {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly value: unknown;
}

interface PlayEvent {
  readonly id: string;
  readonly turn: number;
  readonly actionKind: string;
  readonly outcomeSummary?: string;
}

interface PlayGraphSnapshot {
  readonly entities: ReadonlyArray<PlayEntity>;
  readonly edges: ReadonlyArray<PlayEdge>;
  readonly stateSlots: ReadonlyArray<PlayStateSlot>;
  readonly events: ReadonlyArray<PlayEvent>;
}

interface PlayRunResponse {
  readonly worldId: string;
  readonly runId: string;
  readonly transcript: ReadonlyArray<{
    readonly role: "user" | "assistant" | "system" | "tool";
    readonly content: string;
    readonly timestamp?: number;
  }>;
  readonly currentState: unknown;
  readonly graph: PlayGraphSnapshot;
}

const EMPTY_GRAPH: PlayGraphSnapshot = {
  entities: [],
  edges: [],
  stateSlots: [],
  events: [],
};

export function PlayPage() {
  const [worlds, setWorlds] = useState<PlayWorld[]>([]);
  const [runs, setRuns] = useState<PlayRunSummary[]>([]);
  const [selectedWorldId, setSelectedWorldId] = useState("");
  const [selectedRunId, setSelectedRunId] = useState("");
  const [run, setRun] = useState<PlayRunResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const selectedWorld = useMemo(
    () => worlds.find((world) => world.id === selectedWorldId) ?? null,
    [selectedWorldId, worlds],
  );
  const graph = run?.graph ?? EMPTY_GRAPH;

  useEffect(() => {
    let cancelled = false;
    const loadWorlds = async () => {
      setError(null);
      try {
        const result = await fetchJson<{ worlds: PlayWorld[] }>("/play/worlds");
        if (cancelled) return;
        setWorlds(result.worlds);
        if (!selectedWorldId && result.worlds[0]) {
          setSelectedWorldId(result.worlds[0].id);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void loadWorlds();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedWorldId) return;
    let cancelled = false;
    const loadRuns = async () => {
      setError(null);
      try {
        const result = await fetchJson<{ runs: PlayRunSummary[] }>(
          `/play/worlds/${encodeURIComponent(selectedWorldId)}/runs`,
        );
        if (cancelled) return;
        setRuns(result.runs);
        setSelectedRunId((current) => current && result.runs.some((item) => item.id === current)
          ? current
          : result.runs[0]?.id ?? "main");
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void loadRuns();
    return () => {
      cancelled = true;
    };
  }, [selectedWorldId]);

  useEffect(() => {
    if (!selectedWorldId || !selectedRunId) return;
    let cancelled = false;
    const loadRun = async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await fetchJson<PlayRunResponse>(
          `/play/runs/${encodeURIComponent(selectedWorldId)}/${encodeURIComponent(selectedRunId)}`,
        );
        if (!cancelled) setRun(result);
      } catch (e) {
        if (!cancelled) {
          setRun(null);
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void loadRun();
    return () => {
      cancelled = true;
    };
  }, [selectedRunId, selectedWorldId]);

  return (
    <div className="h-full w-full bg-[radial-gradient(circle_at_top_left,rgba(212,175,55,0.12),transparent_28%),linear-gradient(180deg,rgba(255,255,255,0.02),transparent)]">
      <div className="mx-auto flex h-full max-w-7xl flex-col px-6 py-6">
        <header className="mb-5 rounded-2xl border border-border/50 bg-card/70 p-5 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="mb-2 inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
                <Sparkles size={13} />
                InkOS Play
              </div>
              <h1 className="font-serif text-3xl font-semibold tracking-tight">互动世界记录</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                Play 从普通聊天启动和推进：直接说“开一个互动世界，我扮演……”，后续继续输入动作。这里用于查看世界、会话、状态图谱和历史记录。
              </p>
            </div>
            <a
              href="#/chat"
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm"
            >
              <MessageSquare size={15} />
              去普通聊天启动
            </a>
          </div>
        </header>

        {error && (
          <div className="mb-4 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {worlds.length === 0 ? (
          <EmptyPlayState />
        ) : (
          <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[280px_minmax(0,1fr)_320px]">
            <aside className="min-h-0 overflow-y-auto rounded-2xl border border-border/50 bg-card/70 p-4">
              <h2 className="text-sm font-semibold">互动世界</h2>
              <div className="mt-3 space-y-2">
                {worlds.map((world) => (
                  <button
                    key={world.id}
                    type="button"
                    onClick={() => setSelectedWorldId(world.id)}
                    className={`w-full rounded-xl border px-3 py-2 text-left text-sm transition-colors ${
                      world.id === selectedWorldId
                        ? "border-primary/50 bg-primary/10 text-foreground"
                        : "border-border/60 bg-background/60 text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <div className="font-medium">{world.title}</div>
                    <div className="mt-1 truncate text-xs opacity-75">{world.id}</div>
                  </button>
                ))}
              </div>

              <h2 className="mt-5 text-sm font-semibold">会话</h2>
              <div className="mt-3 space-y-2">
                {runs.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSelectedRunId(item.id)}
                    className={`w-full rounded-xl border px-3 py-2 text-left text-sm transition-colors ${
                      item.id === selectedRunId
                        ? "border-primary/50 bg-primary/10 text-foreground"
                        : "border-border/60 bg-background/60 text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <div className="font-medium">{item.id}</div>
                    <div className="mt-1 text-xs opacity-75">{item.eventCount} 事件 · {item.transcriptCount} 消息</div>
                  </button>
                ))}
              </div>
            </aside>

            <main className="flex min-h-0 flex-col rounded-2xl border border-border/50 bg-background/75 p-5">
              {selectedWorld && (
                <div className="mb-4 border-b border-border/50 pb-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-primary/10 px-2 py-1 text-xs font-semibold text-primary">
                      {selectedWorld.mode === "guided" ? "互动选项" : "开放输入"}
                    </span>
                    <h2 className="font-serif text-xl font-semibold">{selectedWorld.title}</h2>
                  </div>
                  {selectedWorld.premise && (
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">{selectedWorld.premise}</p>
                  )}
                </div>
              )}

              <section className="min-h-0 flex-1 overflow-y-auto">
                {loading && <div className="text-sm text-muted-foreground">加载互动记录...</div>}
                {!loading && (!run || run.transcript.length === 0) && (
                  <div className="rounded-xl border border-dashed border-border p-4 text-sm leading-6 text-muted-foreground">
                    这个会话还没有记录。回到普通聊天继续输入动作后，这里会显示场景推进。
                  </div>
                )}
                <div className="space-y-4">
                  {run?.transcript
                    .filter((turn) => turn.role === "user" || turn.role === "assistant")
                    .map((turn, index) => (
                      <div key={`${turn.role}-${index}`} className={turn.role === "user" ? "flex justify-end" : "flex justify-start"}>
                        <div className={`max-w-[82%] rounded-2xl px-4 py-3 text-sm leading-7 shadow-sm ${
                          turn.role === "user"
                            ? "bg-primary text-primary-foreground"
                            : "border border-border/50 bg-card text-foreground"
                        }`}
                        >
                          <div className="whitespace-pre-wrap">{turn.content}</div>
                        </div>
                      </div>
                    ))}
                </div>
              </section>
            </main>

            <aside className="min-h-0 overflow-y-auto rounded-2xl border border-border/50 bg-card/70 p-4">
              <div className="mb-4 flex items-center gap-2">
                <Network size={15} className="text-primary" />
                <h2 className="text-sm font-semibold">状态图谱</h2>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <Metric label="实体" value={graph.entities.length} />
                <Metric label="关系" value={graph.edges.length} />
                <Metric label="状态" value={graph.stateSlots.length} />
                <Metric label="事件" value={graph.events.length} />
              </div>
              {run?.currentState !== null && run?.currentState !== undefined && (
                <pre className="mt-3 max-h-32 overflow-auto rounded-xl bg-background/70 p-3 text-[11px] leading-5 text-muted-foreground">
                  {JSON.stringify(run.currentState, null, 2)}
                </pre>
              )}
              <GraphList title="实体 / 证据" items={graph.entities.slice(0, 8).map((entity) =>
                `${entity.label} [${entity.type}]${entity.status ? ` · ${entity.status}` : ""}`,
              )} />
              <GraphList title="关系" items={graph.edges.slice(0, 8).map((edge) =>
                `${edge.fromId} -${edge.type}-> ${edge.toId}`,
              )} />
              <GraphList title="状态槽" items={graph.stateSlots.slice(0, 8).map((slot) =>
                `${slot.label} [${slot.kind}] ${formatValue(slot.value)}`,
              )} />
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyPlayState() {
  return (
    <div className="flex flex-1 items-center justify-center rounded-2xl border border-dashed border-border bg-card/50 p-8 text-center">
      <div className="max-w-xl">
        <h2 className="font-serif text-2xl font-semibold">从普通聊天开始</h2>
        <p className="mt-3 text-sm leading-7 text-muted-foreground">
          这里不负责填表建世界。去普通聊天说一句类似“开一个互动世界，我扮演雨夜茶馆老板，有人带账本上门”，系统会直接创建世界并进入第一幕。
        </p>
        <a
          href="#/chat"
          className="mt-5 inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm"
        >
          <MessageSquare size={15} />
          去普通聊天
        </a>
      </div>
    </div>
  );
}

function Metric(props: { readonly label: string; readonly value: number }) {
  return (
    <div className="rounded-xl border border-border/60 bg-background/60 p-3">
      <div className="text-muted-foreground">{props.label}</div>
      <div className="mt-1 text-lg font-semibold text-foreground">{props.value}</div>
    </div>
  );
}

function GraphList(props: { readonly title: string; readonly items: ReadonlyArray<string> }) {
  return (
    <section className="mt-6">
      <h2 className="text-sm font-semibold">{props.title}</h2>
      <div className="mt-3 space-y-2">
        {props.items.length === 0
          ? <div className="text-xs text-muted-foreground">暂无</div>
          : props.items.map((item) => (
            <div key={item} className="rounded-xl border border-border/60 bg-background/60 px-3 py-2 text-xs leading-5 text-muted-foreground">
              {item}
            </div>
          ))}
      </div>
    </section>
  );
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}
