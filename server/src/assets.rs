//! Images: upload, content-addressed storage, the WebP derivative ladder, the
//! library listing, and the delete → restore → purge lifecycle.
//!
//! Originals live at `<assets>/ab/cd/<sha256>.<ext>` and are never rewritten.
//! Derivatives live at `<derivatives>/ab/cd/<asset-id>-<width>.webp` and are a
//! cache: lose the directory and they regenerate on the next request.
//!
//! Decoding is the `image` crate rather than libvips, so the desktop app ships
//! with no system dependency. ponytail: JPEG, PNG, WebP, GIF, TIFF and BMP;
//! HEIF, JPEG XL and SVG (which libvips read) are refused with 415 until a
//! decoder for them is worth its weight.

use std::path::{Path, PathBuf};

use axum::Router;
use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Multipart, Path as UrlPath, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::auth::User;
use crate::boards::{self, Op};
use crate::error::{ApiError, ApiResult, Json, is_foreign_key_violation};
use crate::{AppState, NOW, new_id};

pub const WIDTHS: [u32; 5] = [2048, 1024, 512, 256, 64];
const WEBP_QUALITY: f32 = 80.0;
const MAX_UPLOAD_BYTES: usize = 200 * 1024 * 1024;
/// Long-lived, but never in a shared cache: these sit behind a session, and a
/// proxy that cached one would hand it to anybody asking the same URL.
const IMMUTABLE: &str = "private, max-age=31536000, immutable";
const NAMED_BOARDS: i64 = 10;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/assets",
            get(library)
                .post(upload)
                .layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES + 1024 * 1024)),
        )
        .route("/assets/{id}", get(get_asset).patch(rename).delete(delete))
        .route("/assets/{id}/content", get(content))
        .route("/assets/{id}/derivatives/{width}", get(derivative))
        .route("/assets/{id}/restore", post(restore))
        .route("/assets/{id}/file", axum::routing::delete(purge))
}

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct Asset {
    pub id: String,
    pub content_hash: String,
    pub storage_key: String,
    pub original_filename: Option<String>,
    pub mime_type: String,
    pub byte_size: i64,
    pub width: i64,
    pub height: i64,
    pub uploaded_by: Option<String>,
    pub created_at: String,
    pub deleted_at: Option<String>,
}

const COLUMNS: &str = "id, content_hash, storage_key, original_filename, mime_type, byte_size, width, height, \
                       uploaded_by, created_at, deleted_at";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AssetView {
    id: String,
    mime_type: String,
    byte_size: i64,
    width: i64,
    height: i64,
    original_filename: Option<String>,
    deleted_at: Option<String>,
    boards: Option<i64>,
}

impl AssetView {
    fn of(a: Asset, boards: Option<i64>) -> Self {
        Self {
            id: a.id,
            mime_type: a.mime_type,
            byte_size: a.byte_size,
            width: a.width,
            height: a.height,
            original_filename: a.original_filename,
            deleted_at: a.deleted_at,
            boards,
        }
    }
}

async fn find(app: &AppState, id: &Uuid) -> ApiResult<Asset> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {COLUMNS} FROM asset WHERE id = ?"
    )))
    .bind(id.to_string())
    .fetch_optional(&app.db)
    .await?
    .ok_or_else(|| ApiError::not_found(format!("no asset {id}")))
}

// --- images -----------------------------------------------------------------

fn unreadable(detail: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::UNSUPPORTED_MEDIA_TYPE, detail).titled("Not a readable image")
}

fn mime_and_extension(format: ImageFormat) -> Option<(&'static str, &'static str)> {
    Some(match format {
        ImageFormat::Jpeg => ("image/jpeg", "jpg"),
        ImageFormat::Png => ("image/png", "png"),
        ImageFormat::WebP => ("image/webp", "webp"),
        ImageFormat::Gif => ("image/gif", "gif"),
        ImageFormat::Tiff => ("image/tiff", "tiff"),
        ImageFormat::Bmp => ("image/bmp", "bmp"),
        _ => return None,
    })
}

struct Probe {
    width: u32,
    height: u32,
    mime: &'static str,
    extension: &'static str,
}

/// Reads the header only. Width and height are as displayed: an EXIF
/// quarter-turn swaps them, because that is the shape the canvas will draw.
fn probe(path: &Path) -> Result<Probe, String> {
    let reader = ImageReader::open(path)
        .map_err(|e| e.to_string())?
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let format = reader.format().ok_or("not a recognised image format")?;
    let (mime, extension) =
        mime_and_extension(format).ok_or_else(|| format!("{format:?} is not supported"))?;
    let mut decoder = reader.into_decoder().map_err(|e| e.to_string())?;
    let (w, h) = decoder.dimensions();
    let quarter_turn = matches!(
        decoder
            .orientation()
            .unwrap_or(image::metadata::Orientation::NoTransforms),
        image::metadata::Orientation::Rotate90
            | image::metadata::Orientation::Rotate270
            | image::metadata::Orientation::Rotate90FlipH
            | image::metadata::Orientation::Rotate270FlipH
    );
    let (width, height) = if quarter_turn { (h, w) } else { (w, h) };
    if width == 0 || height == 0 {
        return Err("the image has no pixels".into());
    }
    Ok(Probe {
        width,
        height,
        mime,
        extension,
    })
}

fn decode_oriented(path: &Path) -> Result<DynamicImage, String> {
    let reader = ImageReader::open(path)
        .map_err(|e| e.to_string())?
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let mut decoder = reader.into_decoder().map_err(|e| e.to_string())?;
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut img = DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?;
    img.apply_orientation(orientation);
    Ok(img)
}

/// Never upscales: a 300 px original asked for at 512 is encoded at 300. The
/// height comes from the ORIGINAL's aspect, not `img`'s, so resizing tier from
/// tier does not compound rounding.
fn shrink(img: &DynamicImage, width: u32, original: (u32, u32)) -> DynamicImage {
    if width >= img.width() {
        return img.clone();
    }
    let height = ((original.1 as f64 * width as f64 / original.0 as f64).round() as u32).max(1);
    img.resize_exact(width, height, image::imageops::FilterType::Triangle)
}

fn encode_webp(img: &DynamicImage) -> Result<Vec<u8>, String> {
    let pixels = if img.color().has_alpha() {
        DynamicImage::ImageRgba8(img.to_rgba8())
    } else {
        DynamicImage::ImageRgb8(img.to_rgb8())
    };
    let encoder = webp::Encoder::from_image(&pixels).map_err(|e| e.to_string())?;
    Ok(encoder.encode(WEBP_QUALITY).to_vec())
}

/// Writes through a temp file and a rename, so a reader never sees half a file
/// and two racing writers both leave a whole one.
fn write_atomically(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    std::fs::create_dir_all(target.parent().unwrap())?;
    let temp = target.with_extension(format!("building-{}", Uuid::new_v4().simple()));
    std::fs::write(&temp, bytes)?;
    std::fs::rename(&temp, target).inspect_err(|_| {
        // The rename's error is the one returned; a stray temp is clutter.
        let _ = std::fs::remove_file(&temp);
    })
}

fn derivative_path(root: &Path, asset_id: &str, width: u32) -> PathBuf {
    let flat = asset_id.replace('-', "");
    root.join(&flat[0..2])
        .join(&flat[2..4])
        .join(format!("{asset_id}-{width}.webp"))
}

fn original_path(root: &Path, storage_key: &str) -> ApiResult<PathBuf> {
    if storage_key.split('/').any(|p| p == ".." || p.is_empty()) {
        return Err(ApiError::internal("storage key escapes the storage root"));
    }
    Ok(root.join(storage_key))
}

/// Decodes the original once and walks down the requested widths, each one
/// resized from the last — far cheaper than five full decodes.
async fn materialise(app: &AppState, asset: &Asset, widths: Vec<u32>) -> ApiResult<()> {
    let original = original_path(&app.config.assets, &asset.storage_key)?;
    let root = app.config.derivatives.clone();
    let id = asset.id.clone();
    let todo: Vec<u32> = widths
        .into_iter()
        .filter(|w| !derivative_path(&root, &id, *w).exists())
        .collect();
    if todo.is_empty() {
        return Ok(());
    }
    let _permit = app
        .image_permits
        .acquire()
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut current = decode_oriented(&original)?;
        let dims = (current.width(), current.height());
        let mut sorted = todo;
        sorted.sort_unstable_by(|a, b| b.cmp(a));
        for width in sorted {
            current = shrink(&current, width, dims);
            write_atomically(&derivative_path(&root, &id, width), &encode_webp(&current)?)
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| ApiError::internal(e.to_string()))?
    .map_err(|e| ApiError::internal(format!("could not generate a derivative: {e}")))
}

// --- upload -----------------------------------------------------------------

/// Removes the spooled upload however the request ends.
struct TempFile(PathBuf);
impl Drop for TempFile {
    fn drop(&mut self) {
        // Already moved into place, or never written: nothing to clean up.
        let _ = std::fs::remove_file(&self.0);
    }
}

/// An upload on its way in, from any source: written, hashed and counted as
/// it arrives, then stored as an asset like every other (same bytes, same
/// asset). Spooled inside the assets root, so storing it is a rename.
pub struct Spool {
    temp: TempFile,
    file: tokio::fs::File,
    hasher: Sha256,
    size: usize,
}

impl Spool {
    pub async fn new(app: &AppState) -> ApiResult<Self> {
        let temp = TempFile(
            app.config
                .assets
                .join(format!(".incoming-{}.tmp", Uuid::new_v4().simple())),
        );
        let file = tokio::fs::File::create(&temp.0).await?;
        Ok(Spool {
            temp,
            file,
            hasher: Sha256::new(),
            size: 0,
        })
    }

    pub async fn push(&mut self, chunk: &[u8]) -> ApiResult<()> {
        self.size += chunk.len();
        if self.size > MAX_UPLOAD_BYTES {
            return Err(ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "an image may be at most 200 MB",
            ));
        }
        self.hasher.update(chunk);
        self.file.write_all(chunk).await?;
        Ok(())
    }

    /// Stores what arrived as an asset, or says why it is not an image.
    pub async fn store(
        mut self,
        app: &AppState,
        filename: Option<String>,
        uploader: &str,
    ) -> ApiResult<Asset> {
        self.file.flush().await?;
        if self.size == 0 {
            return Err(unreadable("the upload was empty"));
        }
        let hash = hex::encode(self.hasher.finalize());
        let asset = ingest(
            app,
            &self.temp.0,
            &hash,
            self.size as i64,
            filename,
            uploader,
        )
        .await?;
        // A new image to describe, if a vision model is set up.
        app.vision.poke();
        Ok(asset)
    }
}

async fn upload(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<User>,
    mut multipart: Multipart,
) -> ApiResult<(StatusCode, axum::Json<AssetView>)> {
    let bad = |e: axum::extract::multipart::MultipartError| ApiError::bad_request(e.body_text());
    while let Some(mut field) = multipart.next_field().await.map_err(bad)? {
        if field.name() != Some("file") {
            continue;
        }
        let filename = field.file_name().map(str::to_string);
        let mut spool = Spool::new(&app).await?;
        while let Some(chunk) = field.chunk().await.map_err(bad)? {
            spool.push(&chunk).await?;
        }
        let asset = spool.store(&app, filename, &me.id).await?;
        return Ok((StatusCode::CREATED, axum::Json(AssetView::of(asset, None))));
    }
    Err(ApiError::bad_request(
        "a multipart field named 'file' is required",
    ))
}

async fn ingest(
    app: &AppState,
    spooled: &Path,
    hash: &str,
    size: i64,
    filename: Option<String>,
    uploader: &str,
) -> ApiResult<Asset> {
    let path = spooled.to_path_buf();
    let info = tokio::task::spawn_blocking(move || probe(&path))
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|e| unreadable(format!("not a readable image: {e}")))?;

    let key = format!("{}/{}/{hash}.{}", &hash[0..2], &hash[2..4], info.extension);
    let target = app.config.assets.join(&key);
    if !target.exists() {
        tokio::fs::create_dir_all(target.parent().unwrap()).await?;
        tokio::fs::rename(spooled, &target).await?;
    }

    // Same bytes → same asset. Re-uploading a deleted image brings it back.
    let inserted: Option<Asset> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "INSERT INTO asset (id, content_hash, storage_key, original_filename, mime_type, byte_size, width, height, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (content_hash) DO UPDATE SET deleted_at = NULL WHERE deleted_at IS NOT NULL
         RETURNING {COLUMNS}"
    )))
    .bind(new_id())
    .bind(hash)
    .bind(&key)
    .bind(filename)
    .bind(info.mime)
    .bind(size)
    .bind(info.width as i64)
    .bind(info.height as i64)
    .bind(uploader)
    .fetch_optional(&app.db)
    .await?;
    let asset = match inserted {
        Some(a) => a,
        None => {
            sqlx::query_as(sqlx::AssertSqlSafe(format!(
                "SELECT {COLUMNS} FROM asset WHERE content_hash = ?"
            )))
            .bind(hash)
            .fetch_one(&app.db)
            .await?
        }
    };

    let ladder: Vec<u32> = WIDTHS
        .into_iter()
        .filter(|w| (*w as i64) < asset.width)
        .collect();
    let started = std::time::Instant::now();
    let tiers = ladder.len();
    match materialise(app, &asset, ladder).await {
        Ok(_) => tracing::debug!(
            asset = %asset.id,
            tiers,
            duration_ms = started.elapsed().as_millis() as u64,
            "derivatives generated"
        ),
        Err(e) => {
            tracing::warn!(asset = %asset.id, error = %e.detail, "could not pre-generate derivatives")
        }
    }
    Ok(asset)
}

// --- library ----------------------------------------------------------------

#[derive(Deserialize)]
struct LibraryParams {
    q: Option<String>,
    collection: Option<Uuid>,
    sort: Option<String>,
    deleted: Option<String>,
    cursor: Option<String>,
    limit: Option<i64>,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Sort {
    Recent,
    Name,
}

impl Sort {
    fn parse(value: Option<&str>) -> ApiResult<Self> {
        match value.map(str::to_ascii_lowercase).as_deref() {
            None | Some("") | Some("recent") => Ok(Sort::Recent),
            Some("name") => Ok(Sort::Name),
            Some(other) => Err(ApiError::bad_request(format!(
                "no sort order called {other}"
            ))),
        }
    }
    fn wire(self) -> &'static str {
        match self {
            Sort::Recent => "recent",
            Sort::Name => "name",
        }
    }
}

/// Where a page stopped: the sort key of its last row plus that row's id, since
/// neither timestamps nor filenames are unique. Opaque to the client.
#[derive(Debug, PartialEq)]
struct PageCursor {
    sort: Sort,
    key: Option<String>,
    id: String,
}

impl PageCursor {
    fn encode(&self) -> String {
        let key = self
            .key
            .as_deref()
            .map(|k| B64.encode(k))
            .unwrap_or_default();
        B64.encode(format!("{}:{key}:{}", self.sort.wire(), self.id))
    }
    fn decode(encoded: &str) -> Option<Self> {
        let text = String::from_utf8(B64.decode(encoded).ok()?).ok()?;
        let mut parts = text.splitn(3, ':');
        let sort = Sort::parse(Some(parts.next()?)).ok()?;
        let key = parts.next()?;
        let id = Uuid::parse_str(parts.next()?).ok()?.to_string();
        let key = if key.is_empty() {
            None
        } else {
            Some(String::from_utf8(B64.decode(key).ok()?).ok()?)
        };
        if sort == Sort::Recent && key.is_none() {
            return None;
        }
        Some(Self { sort, key, id })
    }
}

#[derive(sqlx::FromRow)]
struct LibraryRow {
    #[sqlx(flatten)]
    asset: Asset,
    boards: i64,
    name_key: Option<String>,
}

async fn library(
    State(app): State<AppState>,
    Query(p): Query<LibraryParams>,
) -> ApiResult<axum::Json<serde_json::Value>> {
    let sort = Sort::parse(p.sort.as_deref())?;
    let deleted = matches!(p.deleted.as_deref(), Some("true" | "1" | "yes" | "on"));
    let limit = match p.limit {
        Some(n) if n >= 1 => n.min(500),
        _ => 100,
    };
    let cursor = match p.cursor.as_deref().filter(|c| !c.is_empty()) {
        None => None,
        Some(raw) => {
            let c =
                PageCursor::decode(raw).ok_or_else(|| ApiError::bad_request("malformed cursor"))?;
            if c.sort != sort {
                return Err(ApiError::bad_request(format!(
                    "this cursor pages a {}-ordered library; start again to sort by {}",
                    c.sort.wire(),
                    sort.wire()
                )));
            }
            Some(c)
        }
    };

    let mut sql = format!(
        "SELECT {COLUMNS}, lower(original_filename) AS name_key,
                (SELECT count(DISTINCT canvas_id) FROM canvas_item WHERE asset_id = asset.id) AS boards
           FROM asset WHERE deleted_at IS {}",
        if deleted { "NOT NULL" } else { "NULL" }
    );
    let mut binds: Vec<String> = Vec::new();
    if let Some(collection) = p.collection {
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM collection WHERE id = ?)")
                .bind(collection.to_string())
                .fetch_one(&app.db)
                .await?;
        if !exists {
            return Err(ApiError::not_found(format!("no collection {collection}")));
        }
        sql.push_str(" AND id IN (SELECT asset_id FROM asset_collection WHERE collection_id = ?)");
        binds.push(collection.to_string());
    }
    if let Some(term) = p.q.as_deref().filter(|t| !t.trim().is_empty()) {
        // ponytail: SQLite's LIKE folds ASCII case only; ICU is the upgrade if
        // non-Latin filenames need case-insensitive search.
        sql.push_str(" AND original_filename LIKE ? ESCAPE '!'");
        binds.push(format!(
            "%{}%",
            term.replace('!', "!!")
                .replace('%', "!%")
                .replace('_', "!_")
        ));
    }
    if let Some(c) = &cursor {
        match (sort, &c.key) {
            (Sort::Recent, Some(at)) => {
                sql.push_str(" AND (created_at, id) < (?, ?)");
                binds.extend([at.clone(), c.id.clone()]);
            }
            (Sort::Name, None) => {
                sql.push_str(" AND lower(original_filename) IS NULL AND id > ?");
                binds.push(c.id.clone());
            }
            (Sort::Name, Some(name)) => {
                sql.push_str(" AND (lower(original_filename) IS NULL OR (lower(original_filename), id) > (?, ?))");
                binds.extend([name.clone(), c.id.clone()]);
            }
            (Sort::Recent, None) => unreachable!("decode refuses a keyless recent cursor"),
        }
    }
    sql.push_str(match sort {
        Sort::Name => " ORDER BY lower(original_filename) ASC NULLS LAST, id ASC",
        Sort::Recent => " ORDER BY created_at DESC, id DESC",
    });
    sql.push_str(&format!(" LIMIT {}", limit + 1));

    let mut query = sqlx::query_as::<_, LibraryRow>(sqlx::AssertSqlSafe(sql));
    for b in &binds {
        query = query.bind(b);
    }
    let mut rows = query.fetch_all(&app.db).await?;
    let more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    let next = rows.last().filter(|_| more).map(|last| {
        PageCursor {
            sort,
            key: match sort {
                Sort::Recent => Some(last.asset.created_at.clone()),
                Sort::Name => last.name_key.clone(),
            },
            id: last.asset.id.clone(),
        }
        .encode()
    });
    let assets: Vec<AssetView> = rows
        .into_iter()
        .map(|r| AssetView::of(r.asset, Some(r.boards)))
        .collect();
    Ok(axum::Json(json!({ "assets": assets, "nextCursor": next })))
}

// --- one asset --------------------------------------------------------------

async fn get_asset(
    State(app): State<AppState>,
    UrlPath(id): UrlPath<Uuid>,
) -> ApiResult<axum::Json<AssetView>> {
    Ok(axum::Json(AssetView::of(find(&app, &id).await?, None)))
}

fn not_modified(headers: &HeaderMap, etag: &str) -> bool {
    headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.split(',')
                .any(|t| t.trim().trim_start_matches("W/") == etag || t.trim() == "*")
        })
}

async fn send_file(
    path: &Path,
    content_type: &str,
    etag: &str,
    disposition: Option<String>,
) -> ApiResult<Response> {
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|_| ApiError::not_found("the stored file is missing"))?;
    let len = file.metadata().await?.len();
    let mut response = Response::builder()
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_LENGTH, len)
        .header(header::CACHE_CONTROL, IMMUTABLE)
        .header(header::ETAG, etag);
    if let Some(d) = disposition {
        response = response.header(header::CONTENT_DISPOSITION, d);
    }
    Ok(response
        .body(Body::from_stream(tokio_util::io::ReaderStream::new(file)))
        .unwrap())
}

fn not_modified_response(etag: &str) -> Response {
    (
        StatusCode::NOT_MODIFIED,
        [
            (header::ETAG, etag.to_string()),
            (header::CACHE_CONTROL, IMMUTABLE.into()),
        ],
    )
        .into_response()
}

/// `inline`, with the original name in both the ASCII and the RFC 5987 forms,
/// so a drag-out or a save keeps it.
fn disposition(filename: Option<&str>) -> String {
    match filename.filter(|f| !f.trim().is_empty()) {
        None => "inline".into(),
        Some(name) => {
            let ascii: String = name
                .chars()
                .map(|c| {
                    if c.is_ascii_graphic() && c != '"' && c != '\\' || c == ' ' {
                        c
                    } else {
                        '_'
                    }
                })
                .collect();
            let encoded: String = name
                .bytes()
                .map(|b| {
                    if b.is_ascii_alphanumeric() || b"!#$&+-.^_`|~".contains(&b) {
                        (b as char).to_string()
                    } else {
                        format!("%{b:02X}")
                    }
                })
                .collect();
            format!("inline; filename=\"{ascii}\"; filename*=UTF-8''{encoded}")
        }
    }
}

async fn content(
    State(app): State<AppState>,
    UrlPath(id): UrlPath<Uuid>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let asset = find(&app, &id).await?;
    let etag = format!("\"{}\"", asset.content_hash);
    if not_modified(&headers, &etag) {
        return Ok(not_modified_response(&etag));
    }
    let path = original_path(&app.config.assets, &asset.storage_key)?;
    send_file(
        &path,
        &asset.mime_type,
        &etag,
        Some(disposition(asset.original_filename.as_deref())),
    )
    .await
}

async fn derivative(
    State(app): State<AppState>,
    UrlPath((id, width)): UrlPath<(Uuid, u32)>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    serve_derivative(&app, &id, width, &headers).await
}

/// One rung of the WebP ladder, for members and for share-link viewers (who
/// get this and never the original).
pub async fn serve_derivative(
    app: &AppState,
    id: &Uuid,
    width: u32,
    headers: &HeaderMap,
) -> ApiResult<Response> {
    if !WIDTHS.contains(&width) {
        return Err(ApiError::bad_request(format!(
            "no derivative tier at width {width}; the ladder is {WIDTHS:?}"
        )));
    }
    let asset = find(app, id).await?;
    let etag = format!("\"{}-{width}\"", asset.content_hash);
    if not_modified(headers, &etag) {
        return Ok(not_modified_response(&etag));
    }
    materialise(app, &asset, vec![width]).await?;
    send_file(
        &derivative_path(&app.config.derivatives, &asset.id, width),
        "image/webp",
        &etag,
        None,
    )
    .await
}

/// An image as an agent sees it (ADR-0031): the derivative rung at or above
/// `width` (the largest when none is), cropped as the board shows it. A crop
/// is cut from the derivative and sent as PNG; otherwise the WebP goes as is.
/// Returns the bytes, their type, and the width sent.
pub async fn view(
    app: &AppState,
    asset_id: &str,
    width: u32,
    crop: Option<(f64, f64, f64, f64)>,
) -> ApiResult<(Vec<u8>, &'static str, u32)> {
    let id = Uuid::parse_str(asset_id).map_err(|_| ApiError::bad_request("not an asset id"))?;
    let asset = find(app, &id).await?;
    let rung = WIDTHS
        .iter()
        .rev()
        .copied()
        .find(|w| *w >= width)
        .unwrap_or(WIDTHS[0]);
    materialise(app, &asset, vec![rung]).await?;
    let path = derivative_path(&app.config.derivatives, &asset.id, rung);
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    let Some((x, y, w, h)) = crop else {
        let sent = (rung as i64).min(asset.width) as u32;
        return Ok((bytes, "image/webp", sent));
    };
    tokio::task::spawn_blocking(move || -> Result<(Vec<u8>, &'static str, u32), String> {
        let img = image::load_from_memory_with_format(&bytes, ImageFormat::WebP)
            .map_err(|e| e.to_string())?;
        let (iw, ih) = (img.width() as f64, img.height() as f64);
        let cut = img.crop_imm(
            (x * iw) as u32,
            (y * ih) as u32,
            ((w * iw) as u32).max(1),
            ((h * ih) as u32).max(1),
        );
        let mut out = std::io::Cursor::new(Vec::new());
        cut.write_to(&mut out, ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        Ok((out.into_inner(), "image/png", cut.width()))
    })
    .await
    .map_err(|e| ApiError::internal(e.to_string()))?
    .map_err(ApiError::internal)
}

#[derive(Deserialize)]
struct AssetFilename {
    filename: String,
}

async fn rename(
    State(app): State<AppState>,
    UrlPath(id): UrlPath<Uuid>,
    Json(body): Json<AssetFilename>,
) -> ApiResult<axum::Json<AssetView>> {
    let name = body.filename.trim();
    if name.is_empty() || name.chars().count() > 200 {
        return Err(ApiError::bad_request("a filename must be 1–200 characters"));
    }
    let renamed: Option<Asset> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "UPDATE asset SET original_filename = ? WHERE id = ? RETURNING {COLUMNS}"
    )))
    .bind(name)
    .bind(id.to_string())
    .fetch_optional(&app.db)
    .await?;
    Ok(axum::Json(AssetView::of(
        renamed.ok_or_else(|| ApiError::not_found(format!("no asset {id}")))?,
        None,
    )))
}

fn may_delete(asset: &Asset, me: &User) -> ApiResult<()> {
    if me.role < crate::auth::Role::Moderator
        && asset.uploaded_by.as_deref().is_some_and(|u| u != me.id)
    {
        return Err(ApiError::forbidden(
            "only the person who uploaded this image, a moderator or an admin, can delete it",
        ));
    }
    Ok(())
}

#[derive(Deserialize)]
struct DeleteParams {
    #[serde(rename = "withItems")]
    with_items: Option<String>,
}

/// Soft delete. Refused with 409 while a board shows the image, unless
/// `withItems` removes those items first — as ordinary, broadcast operations.
async fn delete(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<User>,
    UrlPath(id): UrlPath<Uuid>,
    Query(p): Query<DeleteParams>,
) -> ApiResult<StatusCode> {
    let asset = find(&app, &id).await?;
    may_delete(&asset, &me)?;
    if matches!(p.with_items.as_deref(), Some("true" | "1" | "yes" | "on")) {
        let placements: Vec<(String, String)> = sqlx::query_as(
            "SELECT canvas_id, id FROM canvas_item WHERE asset_id = ? ORDER BY canvas_id",
        )
        .bind(&asset.id)
        .fetch_all(&app.db)
        .await?;
        let mut by_board: Vec<(String, Vec<Op>)> = Vec::new();
        for (board, item) in placements {
            let op = Op::ItemDelete {
                item_id: Uuid::parse_str(&item).unwrap(),
            };
            match by_board.last_mut() {
                Some((b, ops)) if *b == board => ops.push(op),
                _ => by_board.push((board, vec![op])),
            }
        }
        for (board, mut ops) in by_board {
            let board = Uuid::parse_str(&board).unwrap();
            let actor = boards::Actor {
                user_id: me.id.clone(),
                agent: None,
            };
            let (from, to) = boards::apply(&app, &board, &mut ops, &actor).await?;
            app.rooms.announce(&board, None, from, to, &ops);
        }
    } else {
        let boards: i64 = sqlx::query_scalar(
            "SELECT count(DISTINCT canvas_id) FROM canvas_item WHERE asset_id = ?",
        )
        .bind(&asset.id)
        .fetch_one(&app.db)
        .await?;
        if boards > 0 {
            let usage: Vec<(String, String, i64)> = sqlx::query_as(
                "SELECT c.id, c.title, count(*) FROM canvas_item i JOIN canvas c ON c.id = i.canvas_id
                  WHERE i.asset_id = ? GROUP BY c.id, c.title ORDER BY c.title LIMIT ?",
            )
            .bind(&asset.id)
            .bind(NAMED_BOARDS)
            .fetch_all(&app.db)
            .await?;
            let named: Vec<_> = usage
                .into_iter()
                .map(|(id, title, items)| json!({ "boardId": id, "title": title, "items": items }))
                .collect();
            return Err(ApiError::conflict(format!(
                "this image is still on {boards} board(s). Removing it from them is a separate step."
            ))
            .titled("asset is in use")
            .with("boards", json!(named))
            .with("boardCount", json!(boards)));
        }
    }
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "UPDATE asset SET deleted_at = {NOW} WHERE id = ? AND deleted_at IS NULL"
    )))
    .bind(&asset.id)
    .execute(&app.db)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn restore(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<User>,
    UrlPath(id): UrlPath<Uuid>,
) -> ApiResult<axum::Json<AssetView>> {
    let asset = find(&app, &id).await?;
    may_delete(&asset, &me)?;
    sqlx::query("UPDATE asset SET deleted_at = NULL WHERE id = ?")
        .bind(&asset.id)
        .execute(&app.db)
        .await?;
    Ok(axum::Json(AssetView::of(find(&app, &id).await?, None)))
}

/// Irreversible: the row, the original and every derivative. Admin only, and
/// only for an asset already deleted — purging is never the first step.
async fn purge(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<User>,
    UrlPath(id): UrlPath<Uuid>,
) -> ApiResult<StatusCode> {
    let asset = find(&app, &id).await?;
    if !me.admin {
        return Err(ApiError::forbidden(
            "only an admin can remove an image's bytes",
        ));
    }
    if asset.deleted_at.is_none() {
        return Err(ApiError::conflict(
            "delete this asset first; purging is only ever the second step",
        ));
    }
    sqlx::query("DELETE FROM asset WHERE id = ?")
        .bind(&asset.id)
        .execute(&app.db)
        .await
        .map_err(|e| {
            if is_foreign_key_violation(&e) {
                ApiError::conflict("this image is on a board again; delete it first")
            } else {
                e.into()
            }
        })?;
    let original = tokio::fs::remove_file(original_path(&app.config.assets, &asset.storage_key)?)
        .await
        .is_ok();
    let mut tiers = 0;
    for w in WIDTHS {
        tiers += tokio::fs::remove_file(derivative_path(&app.config.derivatives, &asset.id, w))
            .await
            .is_ok() as u32;
    }
    tracing::info!(asset = %asset.id, original, tiers, "purged asset");
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn cursor_round_trips_and_rejects_junk() {
        for c in [
            PageCursor {
                sort: Sort::Recent,
                key: Some("2026-01-01T00:00:00.000Z".into()),
                id: new_id(),
            },
            PageCursor {
                sort: Sort::Name,
                key: Some("img_0042.jpg: a:b".into()),
                id: new_id(),
            },
            PageCursor {
                sort: Sort::Name,
                key: None,
                id: new_id(),
            },
        ] {
            assert_eq!(PageCursor::decode(&c.encode()), Some(c));
        }
        assert_eq!(PageCursor::decode("not base64!"), None);
        assert_eq!(PageCursor::decode(&B64.encode("recent::not-a-uuid")), None);
    }

    #[test]
    fn shrink_never_upscales_and_keeps_aspect() {
        let img = DynamicImage::new_rgb8(400, 300);
        assert_eq!(
            shrink(&img, 1024, (400, 300)).dimensions_tuple(),
            (400, 300)
        );
        assert_eq!(shrink(&img, 64, (400, 300)).dimensions_tuple(), (64, 48));
    }

    trait Dims {
        fn dimensions_tuple(&self) -> (u32, u32);
    }
    impl Dims for DynamicImage {
        fn dimensions_tuple(&self) -> (u32, u32) {
            (self.width(), self.height())
        }
    }

    #[test]
    fn encodes_a_readable_webp() {
        let bytes = encode_webp(&DynamicImage::new_rgba8(10, 5)).unwrap();
        let back = image::load(Cursor::new(bytes), ImageFormat::WebP).unwrap();
        assert_eq!((back.width(), back.height()), (10, 5));
    }
}
