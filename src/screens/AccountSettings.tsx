import { useEffect, useRef, useState } from "react";
import { api, type DeleteAccountPlan } from "../db/api";
import { PROJECT_COLORS, useAppStore } from "../store/useAppStore";
import { Avatar, fileToAvatarDataUrl } from "./Avatar";

/**
 * 设置 → 账号：资料、密码、删除账号。只能改**自己的**账号 —— 改别人的要先登录成他。
 *
 * 改资料不会同步改各项目名册里绑定了自己的那一行：名册是项目的一部分，
 * 别人可能在那里给你起了个更好认的名字（「张工」而不是「zhangsan」）。
 */
export function AccountPane() {
  const me = useAppStore((s) => s.session?.current);
  const loadSession = useAppStore((s) => s.loadSession);
  const [name, setName] = useState(me?.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => setName(me?.name ?? ""), [me?.name]);
  if (!me) return null;

  const save = async (next: { name?: string; color?: string; avatar?: string }) => {
    setError(null);
    try {
      await api.updateAccount(next.name ?? me.name, next.color ?? me.color, next.avatar);
      await loadSession();
    } catch (err) {
      setError(String(err));
      setName(me.name);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h2 className="text-sm font-bold text-[var(--text)]">我的账号</h2>
        <p className="mb-4 mt-1 text-[10px] leading-relaxed text-[var(--text-dim)]">
          账号只存在这台电脑上。不同账号的项目互相独立，可以在项目里「共享」给别的账号。
        </p>
        <div className="flex items-center gap-3">
          <button
            onClick={() => fileRef.current?.click()}
            title="点击上传照片"
            className="shrink-0 overflow-hidden rounded-full"
          >
            <Avatar person={me} size={44} />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void fileToAvatarDataUrl(file).then((avatar) => save({ avatar }));
              e.target.value = "";
            }}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              onBlur={() => {
                const next = name.trim();
                if (next && next !== me.name) void save({ name: next });
                else setName(me.name);
              }}
              className="rounded border border-[var(--rule)] bg-[var(--surface-alt)] px-2 py-1 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
            />
            <div className="flex gap-0.5">
              {PROJECT_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => void save({ color: c })}
                  className="size-3.5 rounded-full transition-transform hover:scale-125"
                  style={{
                    background: c,
                    outline: c === me.color ? "2px solid var(--text)" : "none",
                    outlineOffset: 1,
                  }}
                />
              ))}
              {me.avatar && (
                <button
                  onClick={() => void save({ avatar: "" })}
                  className="ml-2 text-[10px] text-[var(--text-dim)] hover:text-[var(--danger)]"
                >
                  移除照片
                </button>
              )}
            </div>
          </div>
        </div>
        {error && <p className="mt-2 text-[10px] text-[var(--danger)]">{error}</p>}
      </div>

      <PasswordSection hasPassword={me.hasPassword} onChanged={() => void loadSession()} />
      <DeleteAccountSection hasPassword={me.hasPassword} />
    </div>
  );
}

const INPUT =
  "w-full rounded border border-[var(--rule)] bg-[var(--surface-alt)] px-2 py-1 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]";

function PasswordSection({ hasPassword, onChanged }: { hasPassword: boolean; onChanged: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async (clear: boolean) => {
    setMessage(null);
    if (!clear && next !== again) {
      setMessage({ ok: false, text: "两次输入的新密码不一样" });
      return;
    }
    try {
      await api.setPassword(hasPassword ? current : null, clear ? null : next);
      setCurrent("");
      setNext("");
      setAgain("");
      setMessage({ ok: true, text: clear ? "已取消密码，下次启动直接进入" : "密码已更新" });
      onChanged();
    } catch (err) {
      setMessage({ ok: false, text: String(err) });
    }
  };

  return (
    <div>
      <h2 className="text-sm font-bold text-[var(--text)]">密码</h2>
      <p className="mb-3 mt-1 text-[10px] leading-relaxed text-[var(--text-dim)]">
        可选。设了密码，启动和切换到这个账号时要先输入。它只防止在这台电脑上误进别人的账号，
        数据文件本身不加密。忘了密码没有找回方式。
      </p>
      <div className="flex max-w-[280px] flex-col gap-1.5" onKeyDown={(e) => e.stopPropagation()}>
        {hasPassword && (
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} placeholder="当前密码" className={INPUT} />
        )}
        <input type="password" value={next} onChange={(e) => setNext(e.target.value)} placeholder={hasPassword ? "新密码" : "设一个密码"} className={INPUT} />
        <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} placeholder="再输一遍" className={INPUT} />
        <div className="flex gap-2">
          <button disabled={!next} onClick={() => void submit(false)} className="btn h-7 px-3">
            {hasPassword ? "修改密码" : "设置密码"}
          </button>
          {hasPassword && (
            <button onClick={() => void submit(true)} className="text-[11px] text-[var(--text-dim)] hover:text-[var(--text)]">
              取消密码
            </button>
          )}
        </div>
        {message && (
          <p className={`text-[10px] ${message.ok ? "text-[var(--ok)]" : "text-[var(--danger)]"}`}>{message.text}</p>
        )}
      </div>
    </div>
  );
}

/** 要一字不差敲进去的那个词，同删项目（ProjectList 的 DeleteProjectDialog） */
const CONFIRM_WORD = "delete";

/**
 * 删除账号（Q11）。全软件最重的操作：只属于自己的项目会一起删掉。
 *
 * - 已共享出去的项目必须逐个选一位成员接手，不选不让删
 * - 删之前 Rust 侧自动做一次整库备份（backups/删除账号前-*.db）
 * - 最后一个账号不能删
 */
function DeleteAccountSection({ hasPassword }: { hasPassword: boolean }) {
  const changeSession = useAppStore((s) => s.changeSession);
  const [plan, setPlan] = useState<DeleteAccountPlan | null>(null);
  const [transfers, setTransfers] = useState<Record<number, number>>({});
  const [password, setPassword] = useState("");
  const [word, setWord] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = async () => {
    setError(null);
    try {
      const p = await api.deleteAccountPlan();
      setPlan(p);
      // 默认选每个共享项目的第一位其他成员，用户可以改
      setTransfers(Object.fromEntries(p.sharedProjects.map((s) => [s.id, s.members[0]?.accountId])));
    } catch (err) {
      setError(String(err));
    }
  };

  const ready =
    plan != null &&
    !plan.lastAccount &&
    word.trim().toLowerCase() === CONFIRM_WORD &&
    (!hasPassword || password.length > 0) &&
    plan.sharedProjects.every((s) => transfers[s.id] != null);

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const pairs = Object.entries(transfers).map(([p, a]) => [Number(p), a] as [number, number]);
      await changeSession(() => api.deleteAccount(hasPassword ? password : null, pairs));
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <div>
      <h2 className="text-sm font-bold text-[var(--danger)]">删除账号</h2>
      {!plan ? (
        <>
          <p className="mb-3 mt-1 text-[10px] leading-relaxed text-[var(--text-dim)]">
            只属于你的项目会一起删除；共享出去的项目要先交给其他成员。删除前会自动备份整个数据库。
          </p>
          <button onClick={() => void open()} className="btn h-7 px-3 text-[var(--danger)]">
            删除这个账号…
          </button>
        </>
      ) : plan.lastAccount ? (
        <p className="mt-1 text-[11px] text-[var(--text-dim)]">这是这台电脑上唯一的账号，不能删除。</p>
      ) : (
        <div className="mt-2 flex max-w-[360px] flex-col gap-3 text-[11px] text-[var(--text)]" onKeyDown={(e) => e.stopPropagation()}>
          <div>
            <div className="font-medium">会一起删除的项目（{plan.soloProjects.length}）</div>
            <div className="mt-0.5 text-[var(--text-dim)]">
              {plan.soloProjects.length === 0 ? "没有" : plan.soloProjects.map((p) => `「${p.name}」`).join("")}
            </div>
          </div>
          {plan.sharedProjects.length > 0 && (
            <div>
              <div className="font-medium">要交给别人的共享项目</div>
              {plan.sharedProjects.map((p) => (
                <div key={p.id} className="mt-1 flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">「{p.name}」交给</span>
                  <select
                    value={transfers[p.id] ?? ""}
                    onChange={(e) => setTransfers({ ...transfers, [p.id]: Number(e.target.value) })}
                    className="rounded border border-[var(--rule)] bg-[var(--surface)] px-1 py-0.5 text-[11px]"
                  >
                    {p.members.map((m) => (
                      <option key={m.accountId} value={m.accountId}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          )}
          {hasPassword && (
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="当前密码" className={INPUT} />
          )}
          <label className="text-[var(--text-dim)]">
            确认请输入 <code className="font-semibold text-[var(--text)]">{CONFIRM_WORD}</code>
            <input value={word} onChange={(e) => setWord(e.target.value)} className={`${INPUT} mt-1`} />
          </label>
          <div className="flex gap-2">
            <button onClick={() => setPlan(null)} className="btn h-7 px-3">
              取消
            </button>
            <button
              disabled={!ready || busy}
              onClick={() => void submit()}
              className="h-7 rounded-[var(--r-m)] bg-[var(--danger)] px-3 text-[11px] font-semibold text-white disabled:opacity-40"
            >
              {busy ? "删除中…" : "删除账号"}
            </button>
          </div>
        </div>
      )}
      {error && <p className="mt-2 text-[10px] text-[var(--danger)]">{error}</p>}
    </div>
  );
}
