import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { api, type Account, type Member, type Person, type SharePreview } from "../db/api";
import { BrandLockup } from "../brand/Brand";
import { Icon } from "../brand/Icon";
import { PROJECT_COLORS, useAppStore } from "../store/useAppStore";
import { Avatar } from "./Avatar";
import { Popover } from "./Popover";

/**
 * 账号相关的界面：登录页、账号菜单、项目共享。DESIGN.md §13。
 *
 * 当前账号存在 Rust 侧（src-tauri/src/db.rs 的 Db）。所有「换人」的动作
 * 都走 store.changeSession：先落库，再换会话，再整页重载 —— 所以这里的组件
 * 只管把用户的选择交给 Rust，不自己清任何前端状态。
 */

/* ------------------------------------------------------------------ */
/* 登录页                                                              */
/* ------------------------------------------------------------------ */

/** 上次登录的账号设了密码、或者退出了登录、或者有多个账号时才会看到这一页。 */
export function LoginScreen() {
  const session = useAppStore((s) => s.session);
  const changeSession = useAppStore((s) => s.changeSession);
  const accounts = session?.accounts ?? [];

  const [picked, setPicked] = useState<number | null>(session?.lastAccountId ?? null);
  const [creating, setCreating] = useState(accounts.length === 0);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 上次的账号排最前：最常见的情况是同一个人回来
  const ordered = [...accounts].sort(
    (a, b) => Number(b.id === session?.lastAccountId) - Number(a.id === session?.lastAccountId),
  );
  const target = accounts.find((a) => a.id === picked) ?? null;

  const enter = async (account: Account, pwd: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await changeSession(() => api.login(account.id, pwd));
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  const pick = (account: Account) => {
    setCreating(false);
    setPassword("");
    setError(null);
    setPicked(account.id);
    // 没设密码就不多问一步
    if (!account.hasPassword) void enter(account, null);
  };

  return (
    <div className="grid h-full place-items-center overflow-y-auto bg-[var(--surface)] p-10">
      <div className="w-[420px] max-w-full">
        <BrandLockup fontSize={15} />
        <h1 className="mt-3 text-[24px] leading-none font-semibold tracking-[-0.02em] text-[var(--text)]">
          {creating ? "新建账号" : "选择账号"}
        </h1>
        <p className="mt-2 text-[12px] leading-relaxed text-[var(--text-dim)]">
          每个账号有自己的项目，数据都存在这台电脑上。
        </p>

        {!creating && (
          <div className="mt-6 flex flex-col gap-1.5">
            {ordered.map((a) => (
              <button
                key={a.id}
                onClick={() => pick(a)}
                disabled={busy}
                className={`flex items-center gap-3 rounded-[var(--r-l)] border px-3.5 py-2.5 text-left transition-colors ${
                  picked === a.id
                    ? "border-[var(--accent)] bg-[var(--surface-alt)]"
                    : "border-[var(--rule)] hover:border-[var(--rule-strong)]"
                }`}
              >
                <Avatar person={a} size={30} />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--text)]">
                  {a.name}
                </span>
                {a.hasPassword && (
                  <span title="设了密码" className="text-[var(--text-dim)]">
                    <Icon name="lock" size={13} />
                  </span>
                )}
              </button>
            ))}

            {target?.hasPassword && (
              <form
                className="mt-2 flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void enter(target, password);
                }}
              >
                <input
                  autoFocus
                  type="password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setError(null);
                  }}
                  placeholder={`「${target.name}」的密码`}
                  className="min-w-0 flex-1 rounded-lg border border-[var(--rule)] bg-[var(--surface-alt)] px-2.5 py-1.5 text-xs outline-none focus:border-[var(--accent)]"
                />
                <button type="submit" disabled={busy} className="btn btn-primary h-8 px-3">
                  {busy ? "进入中…" : "进入"}
                </button>
              </form>
            )}

            <button
              onClick={() => {
                setCreating(true);
                setPicked(null);
                setError(null);
              }}
              className="mt-3 flex items-center gap-1.5 self-start text-[12px] text-[var(--text-dim)] hover:text-[var(--text)]"
            >
              <Icon name="plus" size={12} />新建账号
            </button>
          </div>
        )}

        {creating && (
          <NewAccountForm
            onCancel={accounts.length > 0 ? () => setCreating(false) : undefined}
            onCreated={(account, pwd) => void enter(account, pwd)}
          />
        )}

        {error && <p className="mt-3 text-[11px] text-[var(--danger)]">{error}</p>}
      </div>
    </div>
  );
}

/** 名字必填，密码可选（Q3）。设了密码要输两遍：忘了就只能删账号重来。 */
function NewAccountForm({
  onCancel,
  onCreated,
}: {
  onCancel?: () => void;
  onCreated: (account: Account, password: string | null) => void;
}) {
  const accounts = useAppStore((s) => s.session?.accounts ?? []);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mismatch = password !== "" && again !== "" && password !== again;
  const canGo = name.trim().length > 0 && password === again && !busy;

  const submit = async () => {
    if (!canGo) return;
    setBusy(true);
    setError(null);
    try {
      const color = PROJECT_COLORS[accounts.length % PROJECT_COLORS.length];
      const account = await api.createAccount(name.trim(), color, password || null);
      onCreated(account, password || null);
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <form
      className="mt-6 flex flex-col gap-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Field label="名字">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例如：张三"
          className={INPUT}
        />
      </Field>
      <Field label="密码（可选）" hint="只防止在这台电脑上误进别人的账号；数据本身不加密">
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="不设就留空"
          className={INPUT}
        />
      </Field>
      {password !== "" && (
        <Field label="再输一遍">
          <input
            type="password"
            value={again}
            onChange={(e) => setAgain(e.target.value)}
            className={INPUT}
            style={mismatch ? { borderColor: "var(--danger)" } : undefined}
          />
        </Field>
      )}
      {error && <p className="text-[11px] text-[var(--danger)]">{error}</p>}
      <div className="mt-1 flex justify-end gap-2">
        {onCancel && (
          <button type="button" onClick={onCancel} className="btn h-8 px-3">
            返回
          </button>
        )}
        <button type="submit" disabled={!canGo} className="btn btn-primary h-8 px-3">
          {busy ? "创建中…" : "创建并进入"}
        </button>
      </div>
    </form>
  );
}

const INPUT =
  "w-full rounded-lg border border-[var(--rule)] bg-[var(--surface-alt)] px-2.5 py-1.5 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-[var(--text-dim)]">{label}</span>
      {children}
      {hint && <span className="text-[10px] text-[var(--text-dim)]">{hint}</span>}
    </label>
  );
}

/* ------------------------------------------------------------------ */
/* 账号菜单                                                            */
/* ------------------------------------------------------------------ */

/**
 * 头像按钮 + 菜单：切换到别的账号、账号设置、新建账号、退出登录（Q14）。
 * 项目列表页的页头和工作区的工具条各挂一个。
 */
export function AccountMenu({ compact = false }: { compact?: boolean }) {
  const session = useAppStore((s) => s.session);
  const changeSession = useAppStore((s) => s.changeSession);
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState<Account | null>(null);
  const [password, setPassword] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const me = session?.current;
  if (!me) return null;
  const others = (session?.accounts ?? []).filter((a) => a.id !== me.id);

  const go = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await changeSession(action as () => ReturnType<typeof api.login>);
    } catch (err) {
      setError(String(err));
    }
  };

  const switchTo = (a: Account) => {
    if (a.hasPassword) {
      setSwitching(a);
      setPassword("");
      setError(null);
    } else {
      void go(() => api.login(a.id, null));
    }
  };

  const item =
    "flex w-full items-center gap-2 rounded-[var(--r-s)] px-2 py-1.5 text-left text-[12px] text-[var(--text)] hover:bg-[var(--row-hover)]";

  return (
    <>
      <button
        ref={ref}
        onClick={() => setOpen((v) => !v)}
        title={`当前账号：${me.name}`}
        className={`flex items-center gap-1.5 rounded-[var(--r-m)] transition-colors hover:bg-[var(--row-hover)] ${
          compact ? "p-1" : "px-2 py-1"
        }`}
      >
        <Avatar person={me} size={compact ? 20 : 22} />
        {!compact && <span className="max-w-[120px] truncate text-[12px] text-[var(--text)]">{me.name}</span>}
      </button>
      <Popover
        anchor={ref.current}
        open={open}
        onClose={() => {
          setOpen(false);
          setSwitching(null);
          setError(null);
        }}
        align="right"
        width={220}
      >
        <div className="p-1">
          <div className="flex items-center gap-2 px-2 py-1.5">
            <Avatar person={me} size={26} />
            <div className="min-w-0">
              <div className="truncate text-[12px] font-semibold text-[var(--text)]">{me.name}</div>
              <div className="text-[10px] text-[var(--text-dim)]">当前账号</div>
            </div>
          </div>
          <div className="my-1 h-px bg-[var(--rule)]" />

          {others.length > 0 && (
            <>
              <div className="px-2 pt-1 pb-0.5 text-[10px] text-[var(--text-dim)]">切换到</div>
              {others.map((a) => (
                <button key={a.id} onClick={() => switchTo(a)} className={item}>
                  <Avatar person={a} size={18} />
                  <span className="min-w-0 flex-1 truncate">{a.name}</span>
                  {a.hasPassword && <Icon name="lock" size={11} />}
                </button>
              ))}
              {switching && (
                <form
                  className="flex gap-1 px-1 py-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void go(() => api.login(switching.id, password));
                  }}
                >
                  <input
                    autoFocus
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                    placeholder={`${switching.name} 的密码`}
                    className="min-w-0 flex-1 rounded-md border border-[var(--rule)] bg-[var(--surface-alt)] px-2 py-1 text-[11px] outline-none focus:border-[var(--accent)]"
                  />
                  <button type="submit" className="btn h-6 px-2 text-[11px]">进入</button>
                </form>
              )}
              <div className="my-1 h-px bg-[var(--rule)]" />
            </>
          )}

          <button
            onClick={() => {
              setOpen(false);
              useAppStore.getState().openSettings("account");
            }}
            className={item}
          >
            账号设置
          </button>
          <button onClick={() => setCreating(true)} className={item}>
            新建账号…
          </button>
          <button onClick={() => void go(() => api.logout())} className={item}>
            退出登录
          </button>
          {error && <p className="px-2 py-1 text-[10px] text-[var(--danger)]">{error}</p>}
        </div>
      </Popover>

      <AnimatePresence>
        {creating && (
          <Modal onClose={() => setCreating(false)}>
            <div className="text-sm font-semibold text-[var(--text)]">新建账号</div>
            <p className="mt-1 text-[11px] text-[var(--text-dim)]">建好后会切换到新账号。</p>
            <NewAccountForm
              onCancel={() => setCreating(false)}
              onCreated={(a, pwd) => void go(() => api.login(a.id, pwd))}
            />
          </Modal>
        )}
      </AnimatePresence>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 共享                                                                */
/* ------------------------------------------------------------------ */

/**
 * 项目成员与共享。所有者能加人、移除、移交；编辑者只能看名单和自己退出。
 *
 * 加人时如果名册里已有一个同名、还没绑定账号的人员（之前当作「没账号的人」记过），
 * 要问一句「是不是同一个人」—— 是的话把他名下的任务直接接过去（Q6）。
 */
export function ShareDialog({ onClose }: { onClose: () => void }) {
  const project = useAppStore((s) => s.project);
  const role = useAppStore((s) => s.projectRole);
  const members = useAppStore((s) => s.members);
  const session = useAppStore((s) => s.session);
  const loadMembers = useAppStore((s) => s.loadMembers);
  const loadPeople = useAppStore((s) => s.loadPeople);
  const [adding, setAdding] = useState<{ account: Account; preview: SharePreview } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadMembers();
  }, [loadMembers]);

  if (!project || !session?.current) return null;
  const me = session.current;
  const owner = role === "owner";
  const candidates = session.accounts.filter((a) => !members.some((m) => m.accountId === a.id));

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await Promise.all([loadMembers(), loadPeople()]);
      setAdding(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const begin = async (account: Account) => {
    setError(null);
    try {
      const preview = await api.sharePreview(project.id, account.id);
      if (preview.nameClash) {
        setError(`「${account.name}」已经有一个叫「${project.name}」的项目，请先给这个项目改个名。`);
        return;
      }
      if (preview.sameNamePerson) setAdding({ account, preview });
      else await run(() => api.shareProject(project.id, account.id, null));
    } catch (err) {
      setError(String(err));
    }
  };

  /** 移交所有权后自己降为编辑者：重新打开项目，让界面按新角色收起入口 */
  const transfer = async (accountId: number) => {
    await run(() => api.transferOwnership(project.id, accountId));
    const { openProject, closeProject } = useAppStore.getState();
    await closeProject();
    await openProject(project.id);
  };

  /** 退出后这个项目就看不到了：先落库离开，再退出，回到列表 */
  const leave = async () => {
    const { closeProject, loadProjects } = useAppStore.getState();
    await closeProject();
    try {
      await api.leaveProject(project.id);
    } catch (err) {
      setError(String(err));
    }
    await loadProjects();
  };

  return (
    <Modal onClose={onClose} width={440}>
      <div className="flex items-center gap-2">
        <Icon name="share" size={15} />
        <div className="text-sm font-semibold text-[var(--text)]">共享「{project.name}」</div>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-dim)]">
        共享给这台电脑上的其他账号。成员能看到并编辑项目，也会出现在负责人名单里。
      </p>

      <div className="mt-4 flex flex-col gap-1">
        {members.map((m) => (
          <MemberRow
            key={m.accountId}
            member={m}
            isMe={m.accountId === me.id}
            canManage={owner}
            busy={busy}
            onRemove={() => void run(() => api.unshareProject(project.id, m.accountId))}
            onTransfer={() => void transfer(m.accountId)}
          />
        ))}
      </div>

      {owner && candidates.length > 0 && (
        <>
          <div className="mt-4 text-[11px] font-medium text-[var(--text-dim)]">添加成员</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {candidates.map((a) => (
              <button
                key={a.id}
                disabled={busy}
                onClick={() => void begin(a)}
                className="flex items-center gap-1.5 rounded-full border border-[var(--rule)] py-0.5 pr-2.5 pl-0.5 text-[11px] text-[var(--text)] hover:border-[var(--accent)]"
              >
                <Avatar person={a} size={18} />
                {a.name}
                <Icon name="plus" size={10} />
              </button>
            ))}
          </div>
        </>
      )}
      {owner && candidates.length === 0 && (
        <p className="mt-4 text-[11px] text-[var(--text-dim)]">
          这台电脑上的所有账号都已经是成员。要加别人，先在账号菜单里新建账号。
        </p>
      )}

      {adding && (
        <div className="mt-3 rounded-lg bg-[var(--surface-alt)] px-3 py-2.5 text-[11px] leading-relaxed text-[var(--text)]">
          负责人名单里已经有一个「{adding.preview.sameNamePerson?.name}」（没有账号）。
          是同一个人吗？是的话，他名下的任务会直接归到账号「{adding.account.name}」。
          <div className="mt-2 flex justify-end gap-2">
            <button
              disabled={busy}
              onClick={() => void run(() => api.shareProject(project.id, adding.account.id, null))}
              className="btn h-6 px-2.5 text-[11px]"
            >
              不是，另建一个
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void run(() =>
                  api.shareProject(project.id, adding.account.id, adding.preview.sameNamePerson?.id ?? null),
                )
              }
              className="btn btn-primary h-6 px-2.5 text-[11px]"
            >
              是同一个人
            </button>
          </div>
        </div>
      )}

      {error && <p className="mt-3 text-[11px] text-[var(--danger)]">{error}</p>}

      <div className="mt-5 flex items-center justify-between">
        {!owner ? (
          <button
            disabled={busy}
            onClick={() => void leave()}
            className="text-[11px] text-[var(--text-dim)] hover:text-[var(--danger)]"
          >
            退出这个项目
          </button>
        ) : (
          <span />
        )}
        <button onClick={onClose} className="btn h-7 px-3">
          完成
        </button>
      </div>
    </Modal>
  );
}

function MemberRow({
  member,
  isMe,
  canManage,
  busy,
  onRemove,
  onTransfer,
}: {
  member: Member;
  isMe: boolean;
  canManage: boolean;
  busy: boolean;
  onRemove: () => void;
  onTransfer: () => void;
}) {
  const [confirm, setConfirm] = useState<"remove" | "transfer" | null>(null);
  const isOwner = member.role === "owner";
  return (
    <div className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-[var(--row-hover)]">
      <Avatar person={member} size={26} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] text-[var(--text)]">
          {member.name}
          {isMe && <span className="text-[var(--text-dim)]">（我）</span>}
        </div>
        <div className="text-[10px] text-[var(--text-dim)]">{isOwner ? "所有者" : "编辑者"}</div>
      </div>
      {canManage && !isOwner && !confirm && (
        <div className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            disabled={busy}
            onClick={() => setConfirm("transfer")}
            className="rounded px-1.5 py-0.5 text-[10px] text-[var(--text-dim)] hover:text-[var(--text)]"
          >
            设为所有者
          </button>
          <button
            disabled={busy}
            onClick={() => setConfirm("remove")}
            className="rounded px-1.5 py-0.5 text-[10px] text-[var(--text-dim)] hover:text-[var(--danger)]"
          >
            移除
          </button>
        </div>
      )}
      {confirm && (
        <div className="flex items-center gap-1 text-[10px]">
          <span className="text-[var(--text-dim)]">
            {confirm === "remove" ? "移除后对方看不到这个项目" : "你会变成编辑者"}
          </span>
          <button onClick={() => setConfirm(null)} className="rounded px-1.5 py-0.5 text-[var(--text-dim)]">
            取消
          </button>
          <button
            disabled={busy}
            onClick={() => {
              setConfirm(null);
              if (confirm === "remove") onRemove();
              else onTransfer();
            }}
            className="rounded px-1.5 py-0.5 font-semibold text-[var(--danger)]"
          >
            确定
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 一条评论 / 记录的作者，只在共享项目里返回 —— 单人项目里每一条都是自己写的，
 * 标出来只是噪音。作者为空（账号已删除、或从文件导入）时返回「未知」。
 */
export function useAuthorLabel(authorId: number | null | undefined): string | null {
  const shared = useAppStore((s) => s.members.length > 1);
  const accounts = useAppStore((s) => s.session?.accounts);
  if (!shared) return null;
  if (authorId == null) return "未知";
  return accounts?.find((a) => a.id === authorId)?.name ?? "已删除的账号";
}

/** 共享项目、绑定了账号的人员旁边的小标记 */
export function boundAccountName(person: Person, accounts: Account[] | undefined): string | null {
  if (person.accountId == null) return null;
  return accounts?.find((a) => a.id === person.accountId)?.name ?? null;
}

/* ------------------------------------------------------------------ */
/* 通用弹窗                                                            */
/* ------------------------------------------------------------------ */

export function Modal({
  onClose,
  width = 380,
  children,
}: {
  onClose: () => void;
  width?: number;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-6"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 6 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97 }}
        transition={{ type: "spring", stiffness: 320, damping: 26 }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        className="max-w-full rounded-2xl border border-[var(--rule)] bg-[var(--surface)] p-5 shadow-2xl"
        style={{ width }}
      >
        {children}
      </motion.div>
    </motion.div>
  );
}
