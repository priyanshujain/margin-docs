// Full text search is load bearing for the index in M3, and it arrives through libsqlite3-sys's
// bundled build rather than through a cargo feature we can see in Cargo.toml. A dependency bump
// could drop it silently, so the assumption is asserted rather than assumed.

#[test]
fn fts5_is_compiled_in() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE VIRTUAL TABLE probe USING fts5(path, body);
         INSERT INTO probe(path, body) VALUES ('a.md', 'the quick brown fox');
         INSERT INTO probe(path, body) VALUES ('b.md', 'lazy dog sleeping');",
    )
    .expect("fts5 virtual table must be creatable");
    let hit: String = conn
        .query_row("SELECT path FROM probe WHERE probe MATCH 'brown'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(hit, "a.md");
}
