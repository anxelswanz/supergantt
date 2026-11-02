//! 账号、项目成员、共享与人员绑定（DESIGN.md §13，migrations/015_accounts.sql）。
//!
//! ## 这一层管什么、不管什么
//!
//! 管的是**界面层的隔离**：A 登录后看不到 B 的项目、不能删别人拥有的项目、
//! 不能替别人管成员。所有项目级的读写都先过 [`require_member`] / [`require_owner`]，
//! 桌面应用和 CLI 走的是同一套判断。
//!
//! 不管的是**安全**。数据全在一个本地 SQLite 文件里，谁拿到文件都能读出一切；
//! 本地密码只是挡住「在界面上误入别人的账号」。所以这里不做加密，也不在错误
//! 文案里假装做了。
//!
//! ## 两个容易混的概念
//!
//! - **成员**（project_members）：哪个账号能打开这个项目、能做什么
//! - **人员**（people）：能挂到任务上的负责人。可以绑定一个账号，也可以不绑定
//!   （外包、甲方、还没装软件的同事）
//!
//! 两者的连接规则（共享即入名册、绑定须是成员）全部收在这个模块里，
//! 调用方不需要记得「共享完还得顺手建个人」。

use crate::model::*;
use crate::query::now;
use argon2::password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use rusqlite::{params, Connection, OptionalExtension};

/* ------------------------------------------------------------------ */
/* 角色                                                                */
/* ------------------------------------------------------------------ */

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Owner,
    Editor,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Owner => "owner",
            Role::Editor => "editor",
        }
    }

    fn parse(s: &str) -> Option<Role> {
        match s {
            "owner" => Some(Role::Owner),
            "editor" => Some(Role::Editor),
            _ => None,
        }
    }
}

/// 账号在项目里的角色；不是成员返回 None。
pub fn role_of(conn: &Connection, project_id: i64, account_id: i64) -> Result<Option<Role>> {
    let role: Option<String> = conn
        .query_row(
            "SELECT role FROM project_members WHERE project_id = ?1 AND account_id = ?2",
            params![project_id, account_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(role.as_deref().and_then(Role::parse))
}

/// 项目级操作的门。不存在和没权限说同一句话：多说一句「项目存在，只是不是你的」
/// 就把别人的项目 id 泄露出去了。
pub fn require_member(conn: &Connection, project_id: i64, me: i64) -> Result<Role> {
    role_of(conn, project_id, me)?.ok_or_else(|| "项目不存在，或你没有权限访问".to_string())
}

pub fn require_owner(conn: &Connection, project_id: i64, me: i64) -> Result<()> {
    match require_member(conn, project_id, me)? {
        Role::Owner => Ok(()),
        Role::Editor => Err("只有项目所有者能做这件事".into()),
    }
}

/// 任务所在项目的门。按任务 id 进来的操作（风险、评论）用它。
pub fn require_task_member(conn: &Connection, task_id: i64, me: i64) -> Result<i64> {
    let project_id: Option<i64> = conn
        .query_row("SELECT project_id FROM tasks WHERE id = ?1", params![task_id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let project_id = project_id.ok_or_else(|| "任务不存在，或你没有权限访问".to_string())?;
    require_member(conn, project_id, me)?;
    Ok(project_id)
}

/// 按行 id 进来的操作的门：查出那一行属于哪个项目再判断。
/// `sql` 必须是「按 ?1 查出 project_id」的单列查询。
pub fn require_row_member(conn: &Connection, sql: &str, id: i64, me: i64, what: &str) -> Result<i64> {
    let project_id: Option<i64> = conn
        .query_row(sql, params![id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let project_id = project_id.ok_or_else(|| format!("{what}不存在"))?;
    require_member(conn, project_id, me)?;
    Ok(project_id)
}

/// 带作者的内容（评论、逐日记录、事项、复盘）能不能删：作者本人或项目所有者。
/// 作者为空（账号已删除）时只有所有者能删。
pub fn require_author_or_owner(
    conn: &Connection,
    project_id: i64,
    author_id: Option<i64>,
    me: i64,
) -> Result<()> {
    let role = require_member(conn, project_id, me)?;
    if role == Role::Owner || author_id == Some(me) {
        Ok(())
    } else {
        Err("只有作者本人或项目所有者能删除".into())
    }
}

/* ------------------------------------------------------------------ */
/* 账号                                                                */
/* ------------------------------------------------------------------ */

const ACCOUNT_COLS: &str = "id, uuid, name, color, avatar, password_hash IS NOT NULL, sort_order";

fn map_account(r: &rusqlite::Row) -> rusqlite::Result<Account> {
    Ok(Account {
        id: r.get(0)?,
        uuid: r.get(1)?,
        name: r.get(2)?,
        color: r.get(3)?,
        avatar: r.get(4)?,
        has_password: r.get::<_, i64>(5)? != 0,
        sort_order: r.get(6)?,
    })
}

pub fn list_accounts(conn: &Connection) -> Result<Vec<Account>> {
    let mut stmt = conn
        .prepare(&format!("SELECT {ACCOUNT_COLS} FROM accounts ORDER BY sort_order, id"))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], map_account)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub fn get_account(conn: &Connection, id: i64) -> Result<Account> {
    conn.query_row(
        &format!("SELECT {ACCOUNT_COLS} FROM accounts WHERE id = ?1"),
        params![id],
        map_account,
    )
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "账号不存在".to_string())
}

/// 按 id、uuid 或名字找账号。CLI 的 `--account` 用：人记得名字，脚本记得 id。
pub fn find_account(conn: &Connection, selector: &str) -> Result<Account> {
    let by_id = selector.parse::<i64>().ok();
    conn.query_row(
        &format!(
            "SELECT {ACCOUNT_COLS} FROM accounts
              WHERE id = ?1 OR uuid = ?2 OR name = ?2
              ORDER BY (id = ?1) DESC LIMIT 1"
        ),
        params![by_id.unwrap_or(-1), selector],
        map_account,
    )
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| format!("找不到账号「{selector}」"))
}

fn account_name_taken(e: rusqlite::Error, name: &str) -> String {
    if e.to_string().contains("accounts.name") {
        format!("已经有叫「{name}」的账号了")
    } else {
        e.to_string()
    }
}

fn hash_password(password: &str) -> Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| format!("密码处理失败：{e}"))
}

/// 空密码当作「不设密码」。一个只有空字符串的密码等于没有门，
/// 却会让人以为有 —— 不如明明白白地没有。
fn normalize_password(password: Option<String>) -> Option<String> {
    password.filter(|p| !p.is_empty())
}

pub fn create_account(
    conn: &Connection,
    name: String,
    color: String,
    password: Option<String>,
) -> Result<Account> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("账号名字不能为空".into());
    }
    let hash = match normalize_password(password) {
        Some(p) => Some(hash_password(&p)?),
        None => None,
    };
    conn.execute(
        "INSERT INTO accounts (name, color, password_hash, sort_order, created_at)
         VALUES (?1, ?2, ?3, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM accounts), ?4)",
        params![name, color, hash, now()],
    )
    .map_err(|e| account_name_taken(e, &name))?;
    let id = conn.last_insert_rowid();
    relink_people_by_uuid(conn, id)?;
    get_account(conn, id)
}

/// avatar 的约定同 `update_person`：None 不改，Some("") 清除。
pub fn update_account(
    conn: &Connection,
    id: i64,
    name: String,
    color: String,
    avatar: Option<String>,
) -> Result<()> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("账号名字不能为空".into());
    }
    let n = match avatar {
        Some(data) => {
            let value = if data.is_empty() { None } else { Some(data) };
            conn.execute(
                "UPDATE accounts SET name = ?2, color = ?3, avatar = ?4 WHERE id = ?1",
                params![id, name, color, value],
            )
        }
        None => conn.execute(
            "UPDATE accounts SET name = ?2, color = ?3 WHERE id = ?1",
            params![id, name, color],
        ),
    }
    .map_err(|e| account_name_taken(e, &name))?;
    if n == 0 {
        return Err("账号不存在".into());
    }
    Ok(())
}

/// 校验密码。没设密码的账号任何输入都通过。
pub fn verify_password(conn: &Connection, id: i64, password: &str) -> Result<bool> {
    let hash: Option<Option<String>> = conn
        .query_row("SELECT password_hash FROM accounts WHERE id = ?1", params![id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(hash) = hash else {
        return Err("账号不存在".into());
    };
    let Some(hash) = hash else {
        return Ok(true);
    };
    let parsed = PasswordHash::new(&hash).map_err(|e| format!("密码记录损坏：{e}"))?;
    Ok(Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok())
}

/// 改、设或清除密码。设过密码的账号要先验旧密码 —— 否则走开的人没锁屏，
/// 路过的人就能顺手把他的密码改掉。
pub fn set_password(
    conn: &Connection,
    id: i64,
    current: Option<String>,
    next: Option<String>,
) -> Result<()> {
    if !verify_password(conn, id, current.as_deref().unwrap_or(""))? {
        return Err("当前密码不对".into());
    }
    let hash = match normalize_password(next) {
        Some(p) => Some(hash_password(&p)?),
        None => None,
    };
    conn.execute(
        "UPDATE accounts SET password_hash = ?2 WHERE id = ?1",
        params![id, hash],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 删除账号前要用户确认的东西。
pub fn delete_account_plan(conn: &Connection, id: i64) -> Result<DeleteAccountPlan> {
    get_account(conn, id)?;
    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM accounts", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;

    let mut solo = Vec::new();
    let mut shared = Vec::new();
    let mut stmt = conn
        .prepare(
            "SELECT p.id, p.name FROM projects p
               JOIN project_members m ON m.project_id = p.id
              WHERE m.account_id = ?1 AND m.role = 'owner'
              ORDER BY p.sort_order, p.id",
        )
        .map_err(|e| e.to_string())?;
    let owned = stmt
        .query_map(params![id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    for (project_id, name) in owned {
        let others: Vec<Member> = list_members(conn, project_id)?
            .into_iter()
            .filter(|m| m.account_id != id)
            .collect();
        if others.is_empty() {
            solo.push(ProjectRef { id: project_id, name });
        } else {
            shared.push(SharedProjectRef { id: project_id, name, members: others });
        }
    }
    Ok(DeleteAccountPlan { last_account: total <= 1, solo_projects: solo, shared_projects: shared })
}

/**
 * 删除账号。
 *
 * - 已经共享出去的项目必须在 `transfers` 里给出接手的人，缺一个就整次拒绝 ——
 *   自动挑一个人接手看起来省事，但对方会莫名其妙多出一个要负责的项目
 * - 只属于自己的项目一起删掉（调用方负责事先做整库备份）
 * - 绑定这个账号的人员保留并解绑（外键 ON DELETE SET NULL），历史任务不丢
 * - 最后一个账号不能删：删了就没有人能打开这个软件里的任何东西了
 *
 * 整个过程一个事务。
 */
pub fn delete_account(conn: &mut Connection, id: i64, transfers: Vec<(i64, i64)>) -> Result<()> {
    let plan = delete_account_plan(conn, id)?;
    if plan.last_account {
        return Err("这是最后一个账号，不能删除".into());
    }
    for p in &plan.shared_projects {
        let Some((_, to)) = transfers.iter().find(|(pid, _)| *pid == p.id) else {
            return Err(format!("项目「{}」已共享给别人，请先选一位成员接手", p.name));
        };
        if !p.members.iter().any(|m| m.account_id == *to) {
            return Err(format!("接手项目「{}」的人必须是它的成员", p.name));
        }
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for p in &plan.shared_projects {
        let (_, to) = transfers.iter().find(|(pid, _)| *pid == p.id).copied().unwrap();
        move_owner(&tx, p.id, id, to)?;
    }
    for p in &plan.solo_projects {
        tx.execute("DELETE FROM projects WHERE id = ?1", params![p.id])
            .map_err(|e| e.to_string())?;
    }
    // 成员关系、账号设置、折叠状态随外键级联；人员和作者字段置空
    tx.execute("DELETE FROM accounts WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM settings WHERE key = ?1 AND value = ?2", params![LAST_ACCOUNT_KEY, id.to_string()])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// 上次登录的账号。全机设置（settings 表），不归任何账号。
pub const LAST_ACCOUNT_KEY: &str = "session.last_account";

pub fn last_account(conn: &Connection) -> Result<Option<i64>> {
    let v: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = ?1", params![LAST_ACCOUNT_KEY], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(id) = v.and_then(|s| s.parse::<i64>().ok()) else {
        return Ok(None);
    };
    // 记着的账号可能已经被删了
    let exists: bool = conn
        .query_row("SELECT 1 FROM accounts WHERE id = ?1", params![id], |_| Ok(true))
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or(false);
    Ok(exists.then_some(id))
}

pub fn set_last_account(conn: &Connection, id: Option<i64>) -> Result<()> {
    match id {
        Some(id) => conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![LAST_ACCOUNT_KEY, id.to_string()],
        ),
        None => conn.execute("DELETE FROM settings WHERE key = ?1", params![LAST_ACCOUNT_KEY]),
    }
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 首次迁移出来的默认账号叫「我」（SQL 里拿不到系统用户名）。这里换成系统
/// 用户名，只在它还叫「我」、而且只有这一个账号时做 —— 用户自己改过的名字不能动。
pub fn name_default_account(conn: &Connection) -> Result<()> {
    let user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_default();
    let user = user.trim();
    if user.is_empty() {
        return Ok(());
    }
    conn.execute(
        "UPDATE accounts SET name = ?1
          WHERE id = 1 AND name = '我' AND (SELECT COUNT(*) FROM accounts) = 1
            AND NOT EXISTS (SELECT 1 FROM accounts WHERE name = ?1)",
        params![user],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/* ------------------------------------------------------------------ */
/* 成员与共享                                                          */
/* ------------------------------------------------------------------ */

pub fn list_members(conn: &Connection, project_id: i64) -> Result<Vec<Member>> {
    let mut stmt = conn
        .prepare(
            "SELECT a.id, a.name, a.color, a.avatar, m.role
               FROM project_members m JOIN accounts a ON a.id = m.account_id
              WHERE m.project_id = ?1
              ORDER BY m.role = 'owner' DESC, m.added_at, a.id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![project_id], |r| {
            Ok(Member {
                account_id: r.get(0)?,
                name: r.get(1)?,
                color: r.get(2)?,
                avatar: r.get(3)?,
                role: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/**
 * 项目名在「某个账号看得见的项目」里是否已被占用（migrations/015 把全库唯一
 * 改成了这条规则）。`exclude` 是正在改名的项目自己。
 */
pub fn name_visible_to(conn: &Connection, account_id: i64, name: &str, exclude: Option<i64>) -> Result<bool> {
    conn.query_row(
        "SELECT EXISTS (
           SELECT 1 FROM projects p JOIN project_members m ON m.project_id = p.id
            WHERE m.account_id = ?1 AND p.name = ?2 AND p.id <> ?3)",
        params![account_id, name, exclude.unwrap_or(-1)],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// 改名时对项目的**每个成员**都查一遍：共享项目改个名，不能让 B 的列表里
/// 突然出现两个同名项目。
pub fn check_project_name(conn: &Connection, project_id: Option<i64>, accounts: &[i64], name: &str) -> Result<()> {
    for &a in accounts {
        if name_visible_to(conn, a, name, project_id)? {
            return Err(format!("已有名为「{name}」的项目"));
        }
    }
    Ok(())
}

pub fn member_ids(conn: &Connection, project_id: i64) -> Result<Vec<i64>> {
    let mut stmt = conn
        .prepare("SELECT account_id FROM project_members WHERE project_id = ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![project_id], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// 共享前的预检：对方是否已经能看到同名项目、名册里有没有同名未绑定的人。
/// 界面据此决定直接共享，还是先问「要不要绑定到这个人」。
pub fn share_preview(conn: &Connection, project_id: i64, me: i64, target: i64) -> Result<SharePreview> {
    require_owner(conn, project_id, me)?;
    let account = get_account(conn, target)?;
    let already_member = role_of(conn, project_id, target)?.is_some();
    let name: String = conn
        .query_row("SELECT name FROM projects WHERE id = ?1", params![project_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let name_clash = name_visible_to(conn, target, &name, Some(project_id))?;
    let same_name_person: Option<Person> = conn
        .query_row(
            &format!("SELECT {} FROM people WHERE project_id = ?1 AND name = ?2 AND account_id IS NULL", crate::query::PERSON_COLS),
            params![project_id, account.name],
            crate::query::map_person,
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(SharePreview { already_member, name_clash, same_name_person })
}

/**
 * 把项目共享给另一个账号（加为编辑者），并让对方进入人员名册（Q6）：
 *
 * - `bind_person` 给了：把那个未绑定的人员绑到对方账号（界面问过用户）
 * - 没给：名册里如果已有记着对方 uuid 的人员，就接上它；否则新建一个
 *
 * 对方能看到同名项目时拒绝 —— 让所有者先改名，而不是让对方的列表里
 * 出现两个分不清的项目。
 */
pub fn share_project(
    conn: &mut Connection,
    project_id: i64,
    me: i64,
    target: i64,
    bind_person: Option<i64>,
) -> Result<()> {
    let preview = share_preview(conn, project_id, me, target)?;
    if preview.already_member {
        return Err("对方已经是这个项目的成员了".into());
    }
    if preview.name_clash {
        return Err("对方已经有一个同名项目，请先给这个项目改个名再共享".into());
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO project_members (project_id, account_id, role, added_at) VALUES (?1, ?2, 'editor', ?3)",
        params![project_id, target, now()],
    )
    .map_err(|e| e.to_string())?;
    attach_person(&tx, project_id, target, bind_person)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// 让账号在项目名册里有且只有一个对应的人员。
fn attach_person(conn: &Connection, project_id: i64, account_id: i64, bind_person: Option<i64>) -> Result<()> {
    let already: bool = conn
        .query_row(
            "SELECT 1 FROM people WHERE project_id = ?1 AND account_id = ?2",
            params![project_id, account_id],
            |_| Ok(true),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or(false);
    if already {
        return Ok(());
    }
    let account = get_account(conn, account_id)?;

    if let Some(pid) = bind_person {
        let n = conn
            .execute(
                "UPDATE people SET account_id = ?3, account_uuid = ?4
                  WHERE id = ?1 AND project_id = ?2 AND account_id IS NULL",
                params![pid, project_id, account_id, account.uuid],
            )
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("要绑定的人员不存在，或已经绑定了别的账号".into());
        }
        return Ok(());
    }

    // 以前绑过、取消共享时解绑了的人：靠记着的 uuid 接回去，任务归属不断
    let n = conn
        .execute(
            "UPDATE people SET account_id = ?2
              WHERE id = (SELECT id FROM people
                           WHERE project_id = ?1 AND account_id IS NULL AND account_uuid = ?3
                           LIMIT 1)",
            params![project_id, account_id, account.uuid],
        )
        .map_err(|e| e.to_string())?;
    if n > 0 {
        return Ok(());
    }

    // 新建。名字撞了未绑定的同名人员时加个后缀 —— 用户在预检那一步选了
    // 「不绑定」，说明那是另一个人
    let mut name = account.name.clone();
    let mut i = 2;
    loop {
        let taken: bool = conn
            .query_row(
                "SELECT 1 FROM people WHERE project_id = ?1 AND name = ?2",
                params![project_id, name],
                |_| Ok(true),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or(false);
        if !taken {
            break;
        }
        name = format!("{} ({i})", account.name);
        i += 1;
    }
    conn.execute(
        "INSERT INTO people (project_id, account_id, account_uuid, name, color, avatar, sort_order, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6,
                 (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM people WHERE project_id = ?1), ?7)",
        params![project_id, account_id, account.uuid, name, account.color, account.avatar, now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 取消共享。人员留着、只解绑（account_uuid 留着，再共享时自动接回）。
/// 所有者只能被移交，不能被移除。
pub fn unshare_project(conn: &mut Connection, project_id: i64, me: i64, target: i64) -> Result<()> {
    require_owner(conn, project_id, me)?;
    match role_of(conn, project_id, target)? {
        None => return Err("对方不是这个项目的成员".into()),
        Some(Role::Owner) => return Err("不能移除所有者；请先把所有权移交给别人".into()),
        Some(Role::Editor) => {}
    }
    remove_member(conn, project_id, target)
}

/// 编辑者自己退出一个共享项目。
pub fn leave_project(conn: &mut Connection, project_id: i64, me: i64) -> Result<()> {
    match require_member(conn, project_id, me)? {
        Role::Owner => Err("所有者不能直接退出；请先把所有权移交给别人".into()),
        Role::Editor => remove_member(conn, project_id, me),
    }
}

fn remove_member(conn: &mut Connection, project_id: i64, account_id: i64) -> Result<()> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM project_members WHERE project_id = ?1 AND account_id = ?2",
        params![project_id, account_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE people SET account_id = NULL WHERE project_id = ?1 AND account_id = ?2",
        params![project_id, account_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM task_view_state
          WHERE account_id = ?2 AND task_id IN (SELECT id FROM tasks WHERE project_id = ?1)",
        params![project_id, account_id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// 移交所有权。新所有者必须已是成员；原所有者降为编辑者。
pub fn transfer_ownership(conn: &mut Connection, project_id: i64, me: i64, to: i64) -> Result<()> {
    require_owner(conn, project_id, me)?;
    if to == me {
        return Ok(());
    }
    if role_of(conn, project_id, to)?.is_none() {
        return Err("只能移交给项目成员".into());
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    move_owner(&tx, project_id, me, to)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// 先降旧再升新：「至多一个所有者」的部分唯一索引不允许中间态有两个。
fn move_owner(conn: &Connection, project_id: i64, from: i64, to: i64) -> Result<()> {
    conn.execute(
        "UPDATE project_members SET role = 'editor' WHERE project_id = ?1 AND account_id = ?2",
        params![project_id, from],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE project_members SET role = 'owner' WHERE project_id = ?1 AND account_id = ?2",
        params![project_id, to],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/**
 * 把人员绑定到账号，或解绑（`account_id` 为 None）。
 *
 * 绑定的账号还不是成员时顺带把它加为编辑者（Q6：绑定须是成员）—— 不然会出现
 * 「任务是 B 的，B 却打不开这个项目」。拉人进项目是所有者的权力，所以这种情况
 * 只有所有者能做；绑定到已有成员，编辑者也可以。
 */
pub fn bind_person(conn: &mut Connection, person_id: i64, account_id: Option<i64>, me: i64) -> Result<()> {
    let (project_id, current): (i64, Option<i64>) = conn
        .query_row(
            "SELECT project_id, account_id FROM people WHERE id = ?1",
            params![person_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "人员不存在".to_string())?;
    let my_role = require_member(conn, project_id, me)?;
    if current == account_id {
        return Ok(());
    }

    let Some(target) = account_id else {
        conn.execute(
            "UPDATE people SET account_id = NULL, account_uuid = NULL WHERE id = ?1",
            params![person_id],
        )
        .map_err(|e| e.to_string())?;
        return Ok(());
    };

    let account = get_account(conn, target)?;
    let is_member = role_of(conn, project_id, target)?.is_some();
    if !is_member {
        if my_role != Role::Owner {
            return Err(format!("「{}」还不是项目成员；只有所有者能把人拉进项目", account.name));
        }
        let name: String = conn
            .query_row("SELECT name FROM projects WHERE id = ?1", params![project_id], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if name_visible_to(conn, target, &name, Some(project_id))? {
            return Err(format!("「{}」已经有一个同名项目，请先给这个项目改个名", account.name));
        }
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    // 一个账号在一个项目里只对应一个人员：先把它从别的人员上摘下来
    tx.execute(
        "UPDATE people SET account_id = NULL WHERE project_id = ?1 AND account_id = ?2",
        params![project_id, target],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE people SET account_id = ?2, account_uuid = ?3 WHERE id = ?1",
        params![person_id, target, account.uuid],
    )
    .map_err(|e| e.to_string())?;
    if !is_member {
        tx.execute(
            "INSERT INTO project_members (project_id, account_id, role, added_at) VALUES (?1, ?2, 'editor', ?3)",
            params![project_id, target, now()],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/**
 * 新建账号（或导入了项目）之后，把「记着这个账号 uuid、但还没绑定」的人员接上。
 * 只接对方已经是成员的项目 —— 记着 uuid 不等于有权打开项目。
 */
pub fn relink_people_by_uuid(conn: &Connection, account_id: i64) -> Result<()> {
    conn.execute(
        "UPDATE people SET account_id = ?1
          WHERE account_id IS NULL
            AND account_uuid = (SELECT uuid FROM accounts WHERE id = ?1)
            AND project_id IN (SELECT project_id FROM project_members WHERE account_id = ?1)
            AND NOT EXISTS (SELECT 1 FROM people q
                             WHERE q.project_id = people.project_id AND q.account_id = ?1)",
        params![account_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/* ------------------------------------------------------------------ */
/* 测试                                                                */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;
    use crate::query;
    use crate::schema::MIGRATIONS;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        for sql in MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        conn
    }

    fn names(projects: &[ProjectSummary]) -> Vec<String> {
        projects.iter().map(|p| p.project.name.clone()).collect()
    }

    #[test]
    fn password_is_optional_and_verified() {
        let conn = mem();
        let a = create_account(&conn, "甲".into(), "#000000".into(), None).unwrap();
        assert!(!a.has_password);
        assert!(verify_password(&conn, a.id, "随便").unwrap(), "没设密码的账号任何输入都放行");

        set_password(&conn, a.id, None, Some("abc".into())).unwrap();
        assert!(get_account(&conn, a.id).unwrap().has_password);
        assert!(verify_password(&conn, a.id, "abc").unwrap());
        assert!(!verify_password(&conn, a.id, "abd").unwrap());

        assert!(set_password(&conn, a.id, Some("错的".into()), None).is_err(), "改密码要先验旧密码");
        set_password(&conn, a.id, Some("abc".into()), Some(String::new())).unwrap();
        assert!(!get_account(&conn, a.id).unwrap().has_password, "空密码 = 清除密码");
    }

    #[test]
    fn projects_are_isolated_and_names_unique_per_account() {
        let conn = mem();
        let b = create_account(&conn, "乙".into(), "#000000".into(), None).unwrap().id;
        query::create_project(&conn, 1, "官网".into(), "#111111".into()).unwrap();
        assert!(query::list_projects(&conn, b).unwrap().is_empty(), "乙看不到甲的项目");
        // 全库不再唯一：乙也能建一个同名的
        query::create_project(&conn, b, "官网".into(), "#111111".into()).unwrap();
        assert!(query::create_project(&conn, b, "官网".into(), "#111111".into()).is_err());
        assert_eq!(names(&query::list_projects(&conn, 1).unwrap()), vec!["官网"]);
    }

    #[test]
    fn sharing_adds_member_and_person_and_respects_roles() {
        let mut conn = mem();
        let b = create_account(&conn, "乙".into(), "#000000".into(), None).unwrap().id;
        let p = query::create_project(&conn, 1, "工厂".into(), "#111111".into()).unwrap().id;

        assert!(share_project(&mut conn, p, b, 1, None).is_err(), "编辑者不能共享");
        share_project(&mut conn, p, 1, b, None).unwrap();
        assert_eq!(role_of(&conn, p, b).unwrap(), Some(Role::Editor));
        let people = query::list_people(&conn, p).unwrap();
        assert!(people.iter().any(|x| x.account_id == Some(b) && x.name == "乙"), "共享即入名册");

        assert!(query::delete_project(&conn, b, p).is_err(), "编辑者不能删项目");

        // 取消共享：人员留着，只解绑；再共享时靠 uuid 接回同一个人
        let person = people.iter().find(|x| x.account_id == Some(b)).unwrap().id;
        unshare_project(&mut conn, p, 1, b).unwrap();
        assert!(query::list_projects(&conn, b).unwrap().is_empty());
        let after = query::list_people(&conn, p).unwrap();
        assert!(after.iter().any(|x| x.id == person && x.account_id.is_none()));
        share_project(&mut conn, p, 1, b, None).unwrap();
        let again = query::list_people(&conn, p).unwrap();
        assert_eq!(again.iter().filter(|x| x.name.starts_with('乙')).count(), 1, "不该再多出一个乙");
        assert_eq!(again.iter().find(|x| x.id == person).unwrap().account_id, Some(b));
    }

    #[test]
    fn share_rejects_name_clash_and_can_bind_existing_person() {
        let mut conn = mem();
        let b = create_account(&conn, "乙".into(), "#000000".into(), None).unwrap().id;
        let p = query::create_project(&conn, 1, "工厂".into(), "#111111".into()).unwrap().id;
        query::create_project(&conn, b, "工厂".into(), "#111111".into()).unwrap();
        assert!(share_project(&mut conn, p, 1, b, None).is_err(), "对方有同名项目时拒绝");

        query::rename_project(&conn, 1, p, "工厂二期".into(), "#111111".into()).unwrap();
        let existing = query::create_person(&conn, 1, p, "乙".into(), "#222222".into()).unwrap();
        let preview = share_preview(&conn, p, 1, b).unwrap();
        assert_eq!(preview.same_name_person.as_ref().map(|x| x.id), Some(existing.id));
        share_project(&mut conn, p, 1, b, Some(existing.id)).unwrap();
        let people = query::list_people(&conn, p).unwrap();
        assert_eq!(people.len(), 1);
        assert_eq!(people[0].account_id, Some(b));
    }

    #[test]
    fn binding_a_non_member_adds_them_but_only_owner_may() {
        let mut conn = mem();
        let b = create_account(&conn, "乙".into(), "#000000".into(), None).unwrap().id;
        let c = create_account(&conn, "丙".into(), "#000000".into(), None).unwrap().id;
        let p = query::create_project(&conn, 1, "工厂".into(), "#111111".into()).unwrap().id;
        share_project(&mut conn, p, 1, b, None).unwrap();
        let x = query::create_person(&conn, 1, p, "外包老王".into(), "#222222".into()).unwrap();

        assert!(bind_person(&mut conn, x.id, Some(c), b).is_err(), "编辑者不能借绑定拉人进项目");
        bind_person(&mut conn, x.id, Some(c), 1).unwrap();
        assert_eq!(role_of(&conn, p, c).unwrap(), Some(Role::Editor));

        bind_person(&mut conn, x.id, None, b).unwrap();
        assert_eq!(query::list_people(&conn, p).unwrap().iter().find(|q| q.id == x.id).unwrap().account_id, None);
    }

    #[test]
    fn deleting_account_requires_handover_and_removes_solo_projects() {
        let mut conn = mem();
        let b = create_account(&conn, "乙".into(), "#000000".into(), None).unwrap().id;
        let solo = query::create_project(&conn, 1, "独有".into(), "#111111".into()).unwrap().id;
        let shared = query::create_project(&conn, 1, "共享".into(), "#111111".into()).unwrap().id;
        share_project(&mut conn, shared, 1, b, None).unwrap();

        let plan = delete_account_plan(&conn, 1).unwrap();
        assert_eq!(plan.solo_projects.len(), 1);
        assert_eq!(plan.shared_projects.len(), 1);
        assert!(delete_account(&mut conn, 1, vec![]).is_err(), "共享项目没指定接手人时拒绝");

        delete_account(&mut conn, 1, vec![(shared, b)]).unwrap();
        assert_eq!(role_of(&conn, shared, b).unwrap(), Some(Role::Owner));
        let exists: i64 = conn
            .query_row("SELECT COUNT(*) FROM projects WHERE id = ?1", params![solo], |r| r.get(0))
            .unwrap();
        assert_eq!(exists, 0);
        assert!(delete_account(&mut conn, b, vec![]).is_err(), "最后一个账号不能删");
    }
}
