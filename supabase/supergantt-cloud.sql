-- SuperGantt 云数据备份：在 Supabase 的 SQL Editor 里整段执行一次。
--
-- 执行完，结果面板里会出现一串「同步密钥」。连同项目设置里的 Project URL、
-- anon / publishable key，一起填进 SuperGantt「设置 → 云备份」。
--
-- 为什么要多一串同步密钥：anon key 本来就是公开级别的（任何拿到网页前端的人都看得到），
-- 光靠它保护不了数据。这里的表全部开着 RLS，只有请求头 x-supergantt-key 带着正确密钥
-- 的请求才读写得到。密钥存在一张 anon 读不到的表里。
--
-- 重复执行是安全的：表和策略都是「没有才建」，已有的密钥不会被换掉。
-- 想换密钥：delete from public.supergantt_keys; 再执行一遍本文件。

/* ------------------------------------------------------------------ */
/* 项目快照：一个项目一行，payload 是整份 .ganttproj（base64）          */
/* ------------------------------------------------------------------ */

create table if not exists public.supergantt_projects (
  uuid           text primary key,
  name           text        not null,
  -- .ganttproj 的 base64。和「导出项目文件」是同一种格式，必要时可以手动解出来导入
  payload        text        not null,
  -- 内容指纹（sha256），客户端拿它判断「有没有真的变」
  hash           text        not null,
  -- 每次写入 +1。客户端按它判断云端是否被别的电脑改过，也用它防止两台电脑同时写互相覆盖
  version        bigint      not null default 1,
  format_version text        not null,
  -- 删除不直接删行，只打标记：别的电脑才知道「这个项目被删了」，而不是「我这里多了一个要上传的」
  deleted        boolean     not null default false,
  updated_at     timestamptz not null default now(),
  -- 哪台电脑 / 哪个账号写的，纯展示
  updated_by     text
);

-- updated_at 由库来记，不信客户端的时钟（两台电脑的时间可能差好几分钟）
create or replace function public.supergantt_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists supergantt_projects_touch on public.supergantt_projects;
create trigger supergantt_projects_touch
  before update on public.supergantt_projects
  for each row execute function public.supergantt_touch();

/* ------------------------------------------------------------------ */
/* 同步密钥                                                            */
/* ------------------------------------------------------------------ */

create table if not exists public.supergantt_keys (
  key        text primary key,
  created_at timestamptz not null default now()
);

alter table public.supergantt_keys enable row level security;
-- 不建任何策略：anon / authenticated 一行都读不到，只有下面的 security definer 函数能查
revoke all on public.supergantt_keys from anon, authenticated;

insert into public.supergantt_keys (key)
select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
where not exists (select 1 from public.supergantt_keys);

/** 这次请求带的 x-supergantt-key 对不对 */
create or replace function public.supergantt_authorized()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.supergantt_keys k
     where k.key = coalesce(current_setting('request.headers', true)::json ->> 'x-supergantt-key', '')
  );
$$;

revoke all on function public.supergantt_authorized() from public;
grant execute on function public.supergantt_authorized() to anon, authenticated;

/* ------------------------------------------------------------------ */
/* 权限                                                                */
/* ------------------------------------------------------------------ */

alter table public.supergantt_projects enable row level security;

grant select, insert, update on public.supergantt_projects to anon, authenticated;
-- 不给 delete：删除走 deleted 标记（见上），真正删行只能在 Supabase 后台做
revoke delete on public.supergantt_projects from anon, authenticated;

drop policy if exists supergantt_read on public.supergantt_projects;
create policy supergantt_read on public.supergantt_projects
  for select using (public.supergantt_authorized());

drop policy if exists supergantt_insert on public.supergantt_projects;
create policy supergantt_insert on public.supergantt_projects
  for insert with check (public.supergantt_authorized());

drop policy if exists supergantt_update on public.supergantt_projects;
create policy supergantt_update on public.supergantt_projects
  for update using (public.supergantt_authorized()) with check (public.supergantt_authorized());

/* ------------------------------------------------------------------ */
/* 把同步密钥显示出来 —— 复制它                                          */
/* ------------------------------------------------------------------ */

select key as "同步密钥（复制到 SuperGantt）" from public.supergantt_keys limit 1;
