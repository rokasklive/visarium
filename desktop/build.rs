fn main() {
    // Declaring the commands makes them subject to the capability files, which
    // grant them to the bundled greeting page only — never to a server's pages.
    // The exception is drag-out's two, granted at runtime to the SPA of each
    // signed-in origin (drag_out.rs, ADR-0028).
    let commands = tauri_build::AppManifest::new().commands(&[
        "local_boards",
        "probe",
        "connect",
        "connect_browser",
        "connections",
        "forget",
        "drag_stage",
        "drag_out",
        "local_port",
        "set_local_port",
        "check_for_updates",
        "update_preferences",
        "update_flushed",
        "update_state",
        "update_choose",
        "collect_diagnostics",
        "log_client_error",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(commands))
        .expect("tauri build script");
}
