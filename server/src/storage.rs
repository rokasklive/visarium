//! How much room images have: the admin's limit on the originals, what they
//! take now, and what the disk under them has left. Every new upload is
//! checked against both before a byte of it is kept.
//!
//! Counted: originals, deleted ones too (they stay on disk until purged).
//! Not counted: the WebP ladder, a regenerable cache usually a fraction of
//! the originals, and the database.

use axum::Router;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::auth::{self, Role, User};
use crate::error::{ApiError, ApiResult, Json};
use crate::{AppState, NOW};

/// Left free on the disk whatever the limit says: SQLite, its write-ahead log
/// and the ladder must still be able to write when images have filled it.
pub const DISK_RESERVE: u64 = 1 << 30;

pub fn routes() -> Router<AppState> {
    Router::new().route("/instance/storage", get(show).put(save))
}

pub struct Usage {
    /// Bytes of originals, the trash's included.
    pub used: u64,
    pub trash: u64,
    pub images: i64,
    pub limit: Option<u64>,
    /// Free and total bytes on the disk holding the originals, where known.
    pub disk: Option<(u64, u64)>,
}

pub async fn usage(app: &AppState) -> sqlx::Result<Usage> {
    let (used, trash, images): (i64, i64, i64) = sqlx::query_as(
        "SELECT coalesce(sum(byte_size), 0),
                coalesce(sum(CASE WHEN deleted_at IS NOT NULL THEN byte_size END), 0),
                count(*)
           FROM asset",
    )
    .fetch_one(&app.db)
    .await?;
    let limit: Option<i64> =
        sqlx::query_scalar("SELECT limit_bytes FROM storage_setting WHERE id = 1")
            .fetch_optional(&app.db)
            .await?
            .flatten();
    Ok(Usage {
        used: used as u64,
        trash: trash as u64,
        images,
        limit: limit.map(|l| l as u64),
        disk: disk(&app.config.assets),
    })
}

#[cfg(unix)]
fn disk(path: &std::path::Path) -> Option<(u64, u64)> {
    let s = rustix::fs::statvfs(path).ok()?;
    Some((s.f_bavail * s.f_frsize, s.f_blocks * s.f_frsize))
}

/// ponytail: no disk figures off Unix; the limit still applies.
#[cfg(not(unix))]
fn disk(_: &std::path::Path) -> Option<(u64, u64)> {
    None
}

/// "9.8 GB": decimal units, as Finder and most disk tools show them.
pub fn bytes_text(n: u64) -> String {
    let n = n as f64;
    match n {
        n if n >= 1e12 => format!("{:.1} TB", n / 1e12),
        n if n >= 1e9 => format!("{:.1} GB", n / 1e9),
        n if n >= 1e6 => format!("{:.0} MB", n / 1e6),
        n => format!("{:.0} KB", (n / 1e3).ceil()),
    }
}

/// How many more bytes of originals may arrive, and what to say when an
/// upload goes past them.
pub struct Room {
    pub bytes: u64,
    pub full: String,
}

pub async fn room(app: &AppState) -> ApiResult<Room> {
    let u = usage(app).await?;
    let by_limit_left = u.limit.map(|l| l.saturating_sub(u.used));
    let by_disk_left = u.disk.map(|(free, _)| free.saturating_sub(DISK_RESERVE));
    let trash = if u.trash > 0 {
        format!(", {} of it in the trash", bytes_text(u.trash))
    } else {
        String::new()
    };
    let demo = app.config.demo.as_ref();
    let by_limit = |left: u64| Room {
        bytes: left,
        full: if let Some(d) = demo {
            format!(
                "This demo holds up to {} of your own images, and {} of that is left. Delete some to add more.",
                bytes_text(d.storage_bytes),
                bytes_text(left)
            )
        } else if left == 0 {
            format!(
                "Image storage on this instance is full: {} of {} used{trash}. An admin can raise the limit in Instance Settings.",
                bytes_text(u.used),
                bytes_text(u.limit.unwrap_or(0)),
            )
        } else {
            format!(
                "This image does not fit: image storage has {} left of its {} limit{trash}. An admin can raise the limit in Instance Settings.",
                bytes_text(left),
                bytes_text(u.limit.unwrap_or(0)),
            )
        },
    };
    let by_disk = |left: u64| Room {
        bytes: left,
        full: if left == 0 {
            "The server's disk is almost full, so no more images can be stored. Ask its admin to free some space.".into()
        } else {
            format!(
                "This image does not fit: the server's disk has {} left for images. Ask its admin to free some space.",
                bytes_text(left)
            )
        },
    };
    Ok(match (by_limit_left, by_disk_left) {
        (Some(l), Some(d)) if d < l => by_disk(d),
        (Some(l), _) => by_limit(l),
        (None, Some(d)) => by_disk(d),
        (None, None) => Room {
            bytes: u64::MAX,
            full: String::new(),
        },
    })
}

pub fn full(detail: &str) -> ApiError {
    ApiError::new(StatusCode::INSUFFICIENT_STORAGE, detail).titled("Storage full")
}

fn view(u: &Usage) -> Value {
    json!({
        "usedBytes": u.used,
        "trashBytes": u.trash,
        "images": u.images,
        "limitBytes": u.limit,
        "diskFreeBytes": u.disk.map(|d| d.0),
        "diskTotalBytes": u.disk.map(|d| d.1),
        "diskReserveBytes": DISK_RESERVE,
    })
}

/// Moderators and admins: they look after the library, so they see it fill.
async fn show(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<User>,
) -> ApiResult<axum::Json<Value>> {
    auth::require_role(&me, Role::Moderator)?;
    Ok(axum::Json(view(&usage(&app).await?)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StorageBody {
    /// Null removes the limit.
    limit_bytes: Option<u64>,
}

/// The smallest limit worth setting; below it, a typo is likelier than intent.
const MIN_LIMIT: u64 = 100_000_000;

/// Admins only. A limit below what is already stored is allowed: nothing is
/// deleted, new uploads are refused until enough is purged or it is raised.
async fn save(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<User>,
    Json(body): Json<StorageBody>,
) -> ApiResult<axum::Json<Value>> {
    auth::require_admin(&me)?;
    if let Some(l) = body.limit_bytes
        && !(MIN_LIMIT..=i64::MAX as u64).contains(&l)
    {
        return Err(ApiError::bad_request(format!(
            "a storage limit is at least {}",
            bytes_text(MIN_LIMIT)
        )));
    }
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "INSERT INTO storage_setting (id, limit_bytes) VALUES (1, ?1) \
         ON CONFLICT (id) DO UPDATE SET limit_bytes = ?1, updated_at = {NOW}"
    )))
    .bind(body.limit_bytes.map(|l| l as i64))
    .execute(&app.db)
    .await?;
    tracing::info!(limit_bytes = ?body.limit_bytes, by = %me.id, "storage limit saved");
    Ok(axum::Json(view(&usage(&app).await?)))
}

#[cfg(test)]
mod tests {
    use super::bytes_text;

    #[test]
    fn sizes_read_as_people_say_them() {
        assert_eq!(bytes_text(9_812_000_000), "9.8 GB");
        assert_eq!(bytes_text(200_000_000), "200 MB");
        assert_eq!(bytes_text(1_500), "2 KB");
        assert_eq!(bytes_text(2_000_000_000_000), "2.0 TB");
    }
}
