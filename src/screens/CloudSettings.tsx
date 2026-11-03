import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { api, type CloudConfig } from "../db/api";
import {
  DEFAULT_CLOUD,
  loadCloudConfig,
  runCloudSync,
  saveCloudConfig,
  useCloudStatus,
} from "../cloud/sync";

/**
 * 设置 → 云备份。
 *
 * 用户自己的 Supabase，不经过我们的服务器：下载 SQL → 在 Supabase 里执行 →
 * 把三样东西抄回来 → 测连接 → 打开开关。步骤按这个顺序摆，每一步都写清楚去哪找。
 *
 * 开关只在测通之后才打得开：配错了还开着，用户会以为一直在备份，其实一次都没传上去。
 */

const INTERVALS = [1, 5, 15, 30];

export function CloudPane() {
  const status = useCloudStatus();
  const [draft, setDraft] = useState<CloudConfig>(DEFAULT_CLOUD);
  const [loaded, setLoaded] = useState(false);
  const [check, setCheck] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [sqlMsg, setSqlMsg] = useState<string | null>(null);

  useEffect(() => {
    void loadCloudConfig().then((c) => {
      setDraft(c);
      setLoaded(true);
    });
  }, []);

  const saved = status.config ?? draft;
  const dirty =
    draft.url !== saved.url || draft.anonKey !== saved.anonKey || draft.syncKey !== saved.syncKey;
  const complete = !!(draft.url.trim() && draft.anonKey.trim() && draft.syncKey.trim());

  const set = (patch: Partial<CloudConfig>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setCheck(null);
  };

  /** 测通才算数；测通就存下 */
  const test = async (): Promise<boolean> => {
    setBusy(true);
    try {
      const text = await api.cloudCheck(draft);
      setCheck({ ok: true, text });
      await saveCloudConfig(draft);
      return true;
    } catch (e) {
      setCheck({ ok: false, text: String(e) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const toggle = async () => {
    if (draft.enabled) {
      const next = { ...draft, enabled: false };
      setDraft(next);
      await saveCloudConfig(next);
      return;
    }
    if (!(await test())) return;
    const next = { ...draft, enabled: true };
    setDraft(next);
    // 存下即触发：sync.ts 订阅了配置，开关一开就先跑一轮
    await saveCloudConfig(next);
  };

  const pickInterval = async (m: number) => {
    const next = { ...draft, intervalMin: m };
    setDraft(next);
    if (!dirty) await saveCloudConfig({ ...saved, intervalMin: m });
  };

  const downloadSql = async () => {
    const path = await save({
      defaultPath: "supergantt-cloud.sql",
      filters: [{ name: "SQL", extensions: ["sql"] }],
    });
    if (!path) return;
    await api
      .cloudSaveSql(path)
      .then((p) => setSqlMsg(`已保存到 ${p}`))
      .catch((e) => setSqlMsg(`保存失败：${e}`));
  };

  const copySql = async () => {
    try {
      await navigator.clipboard.writeText(await api.cloudSql());
      setSqlMsg("SQL 已复制，去 Supabase 的 SQL Editor 粘贴执行");
    } catch (e) {
      setSqlMsg(`复制失败：${e}`);
    }
  };

  if (!loaded) return null;

  return (
    <div>
      <h2 className="text-sm font-bold text-[var(--text)]">云备份</h2>
      <p className="mb-4 mt-1 text-[10px] leading-relaxed text-[var(--text-dim)]">
        把你拥有的项目同步到你自己的 Supabase，换电脑、多台电脑之间都能拿到同一份数据。
        数据直接从这台电脑发到你的 Supabase，不经过别处。
      </p>

      {/* 开关 */}
      <button
        onClick={() => void toggle()}
        disabled={busy || (!draft.enabled && !complete)}
        title={!complete && !draft.enabled ? "先把下面三项填好" : undefined}
        className={`mb-4 flex w-full items-center gap-2.5 rounded-xl border p-3 text-left transition-colors disabled:opacity-60 ${
          draft.enabled
            ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]"
            : "border-[var(--rule)] hover:border-[var(--text-dim)]"
        }`}
      >
        <span
          className="grid size-4 shrink-0 place-items-center rounded text-[10px] leading-none text-white"
          style={{ background: draft.enabled ? "var(--accent)" : "var(--rule)" }}
        >
          {draft.enabled ? "✓" : ""}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-semibold text-[var(--text)]">开启云数据备份</span>
          <span className="mt-0.5 block text-[10px] leading-relaxed text-[var(--text-dim)]">
            {draft.enabled
              ? `每 ${draft.intervalMin} 分钟检查一次，有变动才传。两边不一致时以云端为准，被盖掉的本机版存进 backups/`
              : "先按下面的步骤配好，测试连接通过后才能打开"}
          </span>
        </span>
      </button>

      <Step n={1} title="建表">
        <p className="mb-2 text-[10px] leading-relaxed text-[var(--text-dim)]">
          在 Supabase 打开你的项目 → 左侧 <b>SQL Editor</b> → 新建查询，把这份 SQL 整段粘进去执行。
          执行一次就够，重复执行也没关系。
        </p>
        <div className="flex flex-wrap gap-2">
          <SmallButton onClick={() => void copySql()}>复制 SQL</SmallButton>
          <SmallButton onClick={() => void downloadSql()}>下载 SQL 文件…</SmallButton>
        </div>
        {sqlMsg && <div className="mt-1.5 break-all text-[10px] text-[var(--text-dim)]">{sqlMsg}</div>}
      </Step>

      <Step n={2} title="把三样东西填回来">
        <Field
          label="Project URL"
          hint="Project Settings → API（或 Data API），形如 https://xxxx.supabase.co"
          value={draft.url}
          placeholder="https://xxxx.supabase.co"
          onChange={(url) => set({ url })}
        />
        <Field
          label="anon key"
          hint="同一页的 anon public key，或新版的 publishable key（sb_publishable_…）。不要填 service_role"
          value={draft.anonKey}
          secret
          onChange={(anonKey) => set({ anonKey })}
        />
        <Field
          label="同步密钥"
          hint="第 1 步执行完，结果面板里那一串"
          value={draft.syncKey}
          secret
          onChange={(syncKey) => set({ syncKey })}
        />
      </Step>

      <Step n={3} title="测试连接">
        <div className="flex flex-wrap items-center gap-2">
          <SmallButton onClick={() => void test()} disabled={busy || !complete}>
            {busy ? "测试中…" : dirty ? "保存并测试" : "测试连接"}
          </SmallButton>
          {check && (
            <span className={`text-[10px] ${check.ok ? "text-[var(--ok)]" : "text-[var(--danger)]"}`}>
              {check.ok ? "✓ " : ""}
              {check.text}
            </span>
          )}
        </div>
      </Step>

      <div className="mt-4 border-t border-[var(--rule)] pt-3">
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] font-medium text-[var(--text-dim)]">检查间隔</span>
          {INTERVALS.map((m) => (
            <button
              key={m}
              onClick={() => void pickInterval(m)}
              className={`rounded-full border px-2 py-0.5 text-[10px] ${
                draft.intervalMin === m
                  ? "border-[var(--accent)] text-[var(--accent)]"
                  : "border-[var(--rule)] text-[var(--text-dim)] hover:text-[var(--text)]"
              }`}
            >
              {m} 分钟
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <SmallButton
            onClick={() => void runCloudSync()}
            disabled={!saved.enabled || status.running}
          >
            {status.running ? "同步中…" : "立即同步"}
          </SmallButton>
          <LastSync />
        </div>
      </div>
    </div>
  );
}

function LastSync() {
  const { last, error } = useCloudStatus();
  if (error) return <span className="text-[10px] text-[var(--danger)]">上次同步失败：{error}</span>;
  if (!last) return <span className="text-[10px] text-[var(--text-dim)]">还没同步过</span>;

  const at = new Date(last.at * 1000);
  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  const parts: string[] = [];
  if (last.pushed.length) parts.push(`上传 ${last.pushed.length}`);
  if (last.pulled.length) parts.push(`拉取 ${last.pulled.length}`);
  if (last.deletedLocal.length) parts.push(`本机删除 ${last.deletedLocal.length}`);
  if (last.deletedRemote.length) parts.push(`云端删除 ${last.deletedRemote.length}`);

  return (
    <div className="min-w-0 flex-1 text-[10px] leading-relaxed text-[var(--text-dim)]">
      <div>
        {time} 同步完成：{parts.length ? parts.join("，") : "两边一致，没有要传的"}
      </div>
      {last.backups.length > 0 && <div>覆盖前的本机版已存到 backups/（{last.backups.length} 份）</div>}
      {[...last.notes, ...last.errors].map((m) => (
        <div key={m} className={last.errors.includes(m) ? "text-[var(--danger)]" : undefined}>
          · {m}
        </div>
      ))}
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3.5 flex gap-2.5">
      <span className="grid size-5 shrink-0 place-items-center rounded-full bg-[var(--surface-alt)] text-[10px] font-bold text-[var(--text-dim)]">
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <div className="mb-1 text-xs font-semibold text-[var(--text)]">{title}</div>
        {children}
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  value,
  placeholder,
  secret,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  placeholder?: string;
  secret?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <label className="mb-2 block">
      <span className="mb-0.5 block text-[10px] font-medium text-[var(--text)]">{label}</span>
      <input
        value={value}
        type={secret ? "password" : "text"}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value.trim())}
        // 设置页的 Esc 会关窗；在框里按键别漏出去
        onKeyDown={(e) => e.stopPropagation()}
        className="w-full rounded-md border border-[var(--rule)] bg-[var(--surface-alt)] px-2 py-1 font-mono text-[11px] text-[var(--text)] outline-none focus:border-[var(--accent)]"
      />
      <span className="mt-0.5 block text-[9px] leading-snug text-[var(--text-dim)]">{hint}</span>
    </label>
  );
}

function SmallButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-lg border border-[var(--rule)] px-3 py-1.5 text-xs font-medium text-[var(--text-dim)] hover:text-[var(--text)] disabled:opacity-50"
    >
      {children}
    </button>
  );
}
