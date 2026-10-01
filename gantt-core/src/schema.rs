//! Schema：迁移、打开、自愈。
//!
//! 这一份是**唯一**的真相 —— 桌面应用（`src-tauri/src/db.rs`）和 CLI（`gantt-core/src/bin/gantt.rs`）
//! 都用它打开同一个 `gantt.db`。加一列迁移只发生在这里，两边不可能分叉。
//!
//! 从 `src-tauri/src/db.rs` 平移过来，语义一字未改：原先的说明性注释一并带过来，
//! 那些「为什么这么做」才是这段代码里真正值钱的部分。

use rusqlite::Connection;

/// 迁移 SQL。顺序即版本号，见 `migrate`。
///
/// `include_str!` 的路径是相对**本文件**（`gantt-core/src/schema.rs`），所以
/// migrations 目录跟着 crate 走，不再留在 `src-tauri/` 下。
pub const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/001_init.sql"),
    include_str!("../migrations/002_people.sql"),
    include_str!("../migrations/003_notes.sql"),
    include_str!("../migrations/004_blocked.sql"),
    include_str!("../migrations/005_actual_dates.sql"),
    include_str!("../migrations/006_daily_notes.sql"),
    include_str!("../migrations/007_project_identity.sql"),
    include_str!("../migrations/008_risk_resolution.sql"),
    include_str!("../migrations/009_auto_rollover.sql"),
];

/// 打开（必要时创建）数据库，跑完迁移再自愈一遍。
pub fn open(path: &std::path::Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    // WAL：崩溃后能恢复到最后一次提交，且读写不互相阻塞
    conn.pragma_update(None, "journal_mode", "WAL")?;
    migrate(&conn)?;
    Ok(conn)
}

/// 把库补到当前 schema，再自愈一遍已知损坏。
///
/// 单独拆出来是因为整库导入（`dbfile.rs`）要对**别人的库**做同一件事：
/// 另一台电脑上的 Gantt 可能比本机旧几个版本，它的库得先迁到和本机一样，
/// 读取的 SQL 才对得上。两处共用一份迁移逻辑，就不会有「本机能开、导入读不懂」。
pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
        conn.execute_batch(sql)?;
        conn.pragma_update(None, "user_version", (i + 1) as i64)?;
    }
    repair(conn)
}

/**
 * 打开时自愈已知的结构性损坏。
 *
 * 历史上有一个 bug：前端按「当前项目最大 id + 1」分配任务 id，而 tasks.id 是
 * 全局主键，于是一个项目里新建的任务会改写另一个项目的行，并留下
 * **跨项目的父子引用**。那种引用是真正危险的 —— parent_id 上挂着
 * ON DELETE CASCADE，删掉 A 项目的一个任务会连带删掉 B 项目的子树。
 *
 * 这里把这类引用降级成「顶层任务」而不是删掉它们：数据宁可结构变浅，
 * 也不能凭空消失。
 */
pub fn repair(conn: &Connection) -> rusqlite::Result<()> {
    let fixed = conn.execute(
        "UPDATE tasks SET parent_id = NULL
         WHERE parent_id IS NOT NULL
           AND parent_id NOT IN (
                 SELECT p.id FROM tasks p WHERE p.project_id = tasks.project_id
               )",
        [],
    )?;
    if fixed > 0 {
        eprintln!("[repair] 清理了 {fixed} 条跨项目的父子引用（降级为顶层任务）");
    }

    // 自己当自己的父节点会让展平逻辑陷入死循环
    let selfref = conn.execute("UPDATE tasks SET parent_id = NULL WHERE parent_id = id", [])?;
    if selfref > 0 {
        eprintln!("[repair] 清理了 {selfref} 条自引用");
    }
    Ok(())
}

/* ------------------------------------------------------------------ */
/* 测试                                                                */
/* ------------------------------------------------------------------ */

// 这 14 条原本住在 src-tauri/src/db.rs，随 schema / repair / write 一起平移到
// 这里。它们全是**结构层**的测试 —— 直接建表插行、不经过任何业务函数 ——
// 所以哪里有 MIGRATIONS 和 repair，它们就该在哪里。
//
// 留在 src-tauri 是错的：CLI 也要能证明自己打开的库结构正确，而 CLI 不链接
// Tauri。测试跟着代码走，不跟着界面走。
//
// 下面 `use std::result::Result as StdResult;` 是为了不让 `Result` 这个词
// 在测试作用域里撞上 crate 自己的 `Result<T>`（后者只有一个类型参数）。

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        for sql in MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        conn
    }

    #[test]
    fn migrations_apply_cleanly() {
        let conn = mem();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        // projects / tasks / dependencies / baselines / baseline_tasks / settings + sqlite_sequence
        assert!(count >= 6, "建表数量不对：{count}");
    }

    /// daily_notes 的两条关键约束：task_id 可空（项目级记录），
    /// 以及挂在任务上的记录随任务删除一起走 —— 否则时间线上会出现
    /// 一条没有落点的孤儿记录，而用户根本不知道它属于谁。
    #[test]
    fn daily_notes_allow_null_task_and_cascade() {
        let conn = mem();
        conn.execute(
            "INSERT INTO projects (id, name, created_at, updated_at) VALUES (1, 'P', '0', '0')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks (id, project_id, name, start_date, end_date, created_at, updated_at)
             VALUES (1, 1, 'A', '2026-08-03', '2026-08-07', '0', '0')",
            [],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO daily_notes (project_id, task_id, day, content, created_at, updated_at)
             VALUES (1, 1, '2026-08-05', '等料', 0, 0),
                    (1, NULL, '2026-08-05', '今天全场停工', 0, 0)",
            [],
        )
        .unwrap();

        let total: i64 = conn
            .query_row("SELECT COUNT(*) FROM daily_notes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(total, 2, "项目级记录（task_id 为空）必须存得进去");

        conn.execute("DELETE FROM tasks WHERE id = 1", []).unwrap();

        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM daily_notes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 1, "任务删了，挂它的记录要跟着走；项目级那条要留下");

        let orphan: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM daily_notes WHERE task_id IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(orphan, 0);
    }

    /// 002 迁移要把已有的 assignee 文本拆成 people 表并回填外键。
    /// 这是整次改动里唯一会碰用户既有数据的地方，必须逐条验证。
    #[test]
    fn migration_002_backfills_people_from_assignee_text() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();

        // 只跑到 001，模拟升级前的库
        conn.execute_batch(MIGRATIONS[0]).unwrap();
        conn.execute(
            "INSERT INTO projects (id, name, created_at, updated_at) VALUES (1, 'P', '0', '0')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks (id, project_id, name, start_date, end_date, assignee, created_at, updated_at)
             VALUES (1, 1, 'A', '2026-08-03', '2026-08-07', '张三', '0', '0'),
                    (2, 1, 'B', '2026-08-03', '2026-08-07', '李四', '0', '0'),
                    (3, 1, 'C', '2026-08-03', '2026-08-07', '张三', '0', '0'),
                    (4, 1, 'D', '2026-08-03', '2026-08-07', '',     '0', '0')",
            [],
        )
        .unwrap();

        conn.execute_batch(MIGRATIONS[1]).unwrap();

        // 去重：两条张三只产生一个人
        let people: i64 = conn
            .query_row("SELECT COUNT(*) FROM people", [], |r| r.get(0))
            .unwrap();
        assert_eq!(people, 2, "应该只有张三和李四两个人");

        // 空 assignee 不该造出一个空名字的人
        let blank: i64 = conn
            .query_row("SELECT COUNT(*) FROM people WHERE TRIM(name) = ''", [], |r| r.get(0))
            .unwrap();
        assert_eq!(blank, 0);

        // 外键回填正确：任务 1 和 3 指向同一个人
        let (p1, p3): (i64, i64) = conn
            .query_row(
                "SELECT (SELECT person_id FROM tasks WHERE id = 1),
                        (SELECT person_id FROM tasks WHERE id = 3)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(p1, p3);

        // 原来没有负责人的任务保持为空
        let p4: Option<i64> = conn
            .query_row("SELECT person_id FROM tasks WHERE id = 4", [], |r| r.get(0))
            .unwrap();
        assert_eq!(p4, None);

        // 迁移出来的人颜色不能全一样，否则「按负责人着色」失去意义
        let distinct_colors: i64 = conn
            .query_row("SELECT COUNT(DISTINCT color) FROM people", [], |r| r.get(0))
            .unwrap();
        assert_eq!(distinct_colors, 2);

        // 冗余的名字列已经拿掉，不会和 people.name 分叉
        assert!(conn.prepare("SELECT assignee FROM tasks").is_err());
    }

    /// save_project 用的是 upsert 而不是「删光再插入」。
    /// 如果哪天有人改回 DELETE + INSERT，风险点和评论会被外键级联静默清空 ——
    /// 这条测试就是那道闸门。
    #[test]
    fn saving_a_project_must_not_wipe_risks_and_comments() {
        let conn = mem();
        conn.execute(
            "INSERT INTO projects (id, name, created_at, updated_at) VALUES (1, 'P', '0', '0')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks (id, project_id, name, start_date, end_date, created_at, updated_at)
             VALUES (1, 1, 'A', '2026-08-03', '2026-08-07', '0', '0')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO risks (task_id, content, level, created_at) VALUES (1, '接口没定', 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO comments (task_id, content, created_at) VALUES (1, '和后端约了周三', 0)",
            [],
        )
        .unwrap();

        // 模拟一次保存：同一个 id 用 upsert 写回，改了名字和日期
        conn.execute(
            "INSERT INTO tasks
               (id, project_id, name, start_date, end_date, created_at, updated_at)
             VALUES (1, 1, 'A 改名了', '2026-08-05', '2026-08-09', '0', '1')
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               start_date = excluded.start_date,
               end_date = excluded.end_date,
               updated_at = excluded.updated_at",
            [],
        )
        .unwrap();

        let (risks, comments): (i64, i64) = conn
            .query_row(
                "SELECT (SELECT COUNT(*) FROM risks), (SELECT COUNT(*) FROM comments)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(risks, 1, "保存把风险点冲掉了");
        assert_eq!(comments, 1, "保存把评论冲掉了");

        // 但任务真的被删除时，附注应该跟着走，不留孤儿
        conn.execute("DELETE FROM tasks WHERE id = 1", []).unwrap();
        let leftover: i64 = conn
            .query_row(
                "SELECT (SELECT COUNT(*) FROM risks) + (SELECT COUNT(*) FROM comments)",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(leftover, 0);
    }

    /// 曾经的真实数据损坏事故：
    ///
    /// 前端按「当前项目最大 id + 1」分配 id，而 tasks.id 是全局主键。
    /// 在项目 B 里新建任务拿到的 id 撞上项目 A 已有的行时，upsert 的
    /// ON CONFLICT 分支不改 project_id，于是**项目 A 的那条任务被整个改写**，
    /// 而且改完还留在项目 A —— 用户在项目 B 什么都没看到，项目 A 的数据没了。
    ///
    /// 现在跨项目撞车必须让整次保存失败，一个字节都不许写。
    #[test]
    fn cross_project_id_clash_must_abort_the_whole_save() {
        let conn = mem();
        conn.execute(
            "INSERT INTO projects (id, name, created_at, updated_at)
             VALUES (1, 'A', '0', '0'), (2, 'B', '0', '0')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks (id, project_id, name, start_date, end_date, created_at, updated_at)
             VALUES (7, 1, '项目A的重要任务', '2026-08-02', '2026-08-17', '0', '0')",
            [],
        )
        .unwrap();

        // 模拟 save_project 的前置检查：项目 2 想写一个 id=7 的任务
        let ids = "7";
        let clash: i64 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM tasks WHERE project_id <> ?1 AND id IN ({ids})"),
                params![2],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(clash, 1, "没有检出跨项目撞车");

        // 检出之后必须中止，项目 A 的那一行原封不动
        let (name, project): (String, i64) = conn
            .query_row("SELECT name, project_id FROM tasks WHERE id = 7", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(name, "项目A的重要任务");
        assert_eq!(project, 1);
    }

    /// 同项目内的 id 不算撞车 —— 那是正常的「更新已有任务」
    /// 跨项目的 parent_id 是最危险的一种脏数据：parent_id 上挂着
    /// ON DELETE CASCADE，删 A 项目的一个任务会把 B 项目的子树一起带走。
    #[test]
    fn opening_the_db_downgrades_cross_project_parents() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        for sql in MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        conn.execute(
            "INSERT INTO projects (id, name, created_at, updated_at)
             VALUES (1, 'A', '0', '0'), (2, 'B', '0', '0')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks (id, project_id, parent_id, name, start_date, end_date, created_at, updated_at)
             VALUES (6, 1, NULL, 'A的父任务', '2026-08-02', '2026-08-17', '0', '0'),
                    (1, 2, 6,    'B的子任务', '2026-08-03', '2026-08-21', '0', '0'),
                    (2, 2, 2,    '自引用',   '2026-08-03', '2026-08-21', '0', '0')",
            [],
        )
        .unwrap();

        repair(&conn).unwrap();

        // 降级成顶层任务，但**数据本身一条都不能少**
        let (parent, total): (Option<i64>, i64) = conn
            .query_row(
                "SELECT (SELECT parent_id FROM tasks WHERE id = 1), (SELECT COUNT(*) FROM tasks)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(parent, None, "跨项目父引用没有被清掉");
        assert_eq!(total, 3, "修复过程中丢了数据");

        let selfref: Option<i64> = conn
            .query_row("SELECT parent_id FROM tasks WHERE id = 2", [], |r| r.get(0))
            .unwrap();
        assert_eq!(selfref, None, "自引用没有被清掉");
    }

    /// 删一个项目的任务，绝不能连带删掉另一个项目的东西
    #[test]
    fn cascade_never_crosses_project_boundary_after_repair() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        for sql in MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        conn.execute(
            "INSERT INTO projects (id, name, created_at, updated_at)
             VALUES (1, 'A', '0', '0'), (2, 'B', '0', '0')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks (id, project_id, parent_id, name, start_date, end_date, created_at, updated_at)
             VALUES (6, 1, NULL, 'A', '2026-08-02', '2026-08-17', '0', '0'),
                    (1, 2, 6,    'B', '2026-08-03', '2026-08-21', '0', '0')",
            [],
        )
        .unwrap();

        repair(&conn).unwrap();
        conn.execute("DELETE FROM tasks WHERE id = 6", []).unwrap();

        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM tasks WHERE project_id = 2", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 1, "级联删除跨越了项目边界");
    }

    #[test]
    fn same_project_id_is_not_a_clash() {
        let conn = mem();
        conn.execute(
            "INSERT INTO projects (id, name, created_at, updated_at) VALUES (1, 'A', '0', '0')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks (id, project_id, name, start_date, end_date, created_at, updated_at)
             VALUES (7, 1, 'X', '2026-08-02', '2026-08-17', '0', '0')",
            [],
        )
        .unwrap();

        let clash: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM tasks WHERE project_id <> ?1 AND id IN (7)",
                params![1],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(clash, 0);
    }

    /// 新任务的 id 基准必须来自全库，不是当前项目
    #[test]
    fn next_task_id_is_global_not_per_project() {
        let conn = mem();
        conn.execute(
            "INSERT INTO projects (id, name, created_at, updated_at)
             VALUES (1, 'A', '0', '0'), (2, 'B', '0', '0')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks (id, project_id, name, start_date, end_date, created_at, updated_at)
             VALUES (7, 1, 'A的任务', '2026-08-02', '2026-08-17', '0', '0'),
                    (8, 1, 'A的任务2', '2026-08-02', '2026-08-17', '0', '0')",
            [],
        )
        .unwrap();

        // 项目 2 一条任务都没有，但下一个 id 必须是 9 而不是 1
        let next: i64 = conn
            .query_row("SELECT COALESCE(MAX(id), 0) + 1 FROM tasks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(next, 9);
    }

    #[test]
    fn deleting_a_person_keeps_their_tasks() {
        let conn = mem();
        conn.execute(
            "INSERT INTO projects (id, name, created_at, updated_at) VALUES (1, 'P', '0', '0')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO people (id, name, color, created_at) VALUES (1, '张三', '#4f46e5', '0')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks (id, project_id, name, start_date, end_date, person_id, created_at, updated_at)
             VALUES (1, 1, 'A', '2026-08-03', '2026-08-07', 1, '0', '0')",
            [],
        )
        .unwrap();

        conn.execute("DELETE FROM people WHERE id = 1", []).unwrap();

        // 任务还在，只是没了负责人 —— 删人不该连带毁掉排期
        let (count, person): (i64, Option<i64>) = conn
            .query_row(
                "SELECT COUNT(*), MAX(person_id) FROM tasks",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(person, None);
    }

    #[test]
    fn people_names_must_be_unique() {
        let conn = mem();
        conn.execute(
            "INSERT INTO people (name, color, created_at) VALUES ('张三', '#000000', '0')",
            [],
        )
        .unwrap();
        assert!(conn
            .execute(
                "INSERT INTO people (name, color, created_at) VALUES ('张三', '#111111', '0')",
                [],
            )
            .is_err());
    }

    #[test]
    fn deleting_project_cascades_to_tasks_and_deps() {
        let conn = mem();
        conn.execute(
            "INSERT INTO projects (id, name, created_at, updated_at) VALUES (1, 'P', '0', '0')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks (id, project_id, name, start_date, end_date, created_at, updated_at)
             VALUES (1, 1, 'A', '2026-08-03', '2026-08-07', '0', '0'),
                    (2, 1, 'B', '2026-08-08', '2026-08-10', '0', '0')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO dependencies (project_id, from_task_id, to_task_id) VALUES (1, 1, 2)",
            [],
        )
        .unwrap();

        conn.execute("DELETE FROM projects WHERE id = 1", []).unwrap();

        for table in ["tasks", "dependencies"] {
            let n: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 0, "{table} 没有被级联删除");
        }
    }

    #[test]
    fn schema_rejects_corrupt_data() {
        let conn = mem();
        conn.execute(
            "INSERT INTO projects (id, name, created_at, updated_at) VALUES (1, 'P', '0', '0')",
            [],
        )
        .unwrap();

        // 结束日期早于开始日期
        assert!(conn
            .execute(
                "INSERT INTO tasks (project_id, name, start_date, end_date, created_at, updated_at)
                 VALUES (1, 'X', '2026-08-10', '2026-08-01', '0', '0')",
                [],
            )
            .is_err());

        // 进度超出 0–1
        assert!(conn
            .execute(
                "INSERT INTO tasks (project_id, name, start_date, end_date, progress, created_at, updated_at)
                 VALUES (1, 'X', '2026-08-01', '2026-08-10', 1.5, '0', '0')",
                [],
            )
            .is_err());

        conn.execute(
            "INSERT INTO tasks (id, project_id, name, start_date, end_date, created_at, updated_at)
             VALUES (1, 1, 'A', '2026-08-01', '2026-08-02', '0', '0')",
            [],
        )
        .unwrap();

        // 自依赖
        assert!(conn
            .execute(
                "INSERT INTO dependencies (project_id, from_task_id, to_task_id) VALUES (1, 1, 1)",
                [],
            )
            .is_err());

        // 未知依赖类型
        assert!(conn
            .execute(
                "INSERT INTO dependencies (project_id, from_task_id, to_task_id, type)
                 VALUES (1, 1, 1, 'XX')",
                [],
            )
            .is_err());
    }

    #[test]
    fn baseline_rows_survive_task_deletion() {
        // 基线里的任务被删掉后，快照必须留着 —— 对比模式要显示「原计划存在，现已删除」
        let conn = mem();
        conn.execute(
            "INSERT INTO projects (id, name, created_at, updated_at) VALUES (1, 'P', '0', '0')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks (id, project_id, name, start_date, end_date, created_at, updated_at)
             VALUES (7, 1, 'A', '2026-08-01', '2026-08-05', '0', '0')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO baselines (id, project_id, name, created_at) VALUES (1, 1, '初始计划', '0')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO baseline_tasks (baseline_id, task_id, name, start_date, end_date, duration)
             SELECT 1, id, name, start_date, end_date, 5 FROM tasks WHERE id = 7",
            [],
        )
        .unwrap();

        conn.execute("DELETE FROM tasks WHERE id = 7", []).unwrap();

        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM baseline_tasks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1, "基线快照不该跟着任务一起被删");
    }
}
