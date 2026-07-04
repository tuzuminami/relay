# AGENTS.md — RELAY 実装規約

## 最優先原則
1. **fail-closed**: 認可・tenant境界・ポリシー・設定検証が不明なら処理を許可しない。
2. **明示性**: 仕様にない推論で機能を足さない。追加はADRとIssueを先に作る。
3. **再現性**: 時刻、乱数、外部Provider、Versionを注入可能にし、テストで固定できる。
4. **監査可能性**: 重要な状態変更にはactor、reason、correlation ID、before/afterまたはハッシュを残す。
5. **商用利用可能性**: GPL/AGPL依存を中核へ持ち込まない。ライセンスを依存追加時に確認する。

## 実装ルール
- TypeScriptは`strict: true`。`any`は禁止。入力は境界でJSON Schema検証する。
- Domain層はHTTP、ORM、Provider SDKへ直接依存しない。
- 外部I/OはAdapter interfaceの背後へ置く。Pluginの失敗は型付きエラーで返す。
- DBクエリでは`tenant_id`を必須条件にする。後段フィルタだけで分離しない。
- 破壊的変更にはmigration、rollback方針、互換性テストを添える。
- 新規APIはOpenAPI、contract test、認可テスト、監査テストを同時に追加する。

## Definition of Done
- 要求IDをPRまたはIssueに記載している。
- unit / integration / contract testsが通る。
- 失敗時の挙動が安全側である。
- OpenAPI・README・変更履歴を更新している。
- 機密情報・個人情報・トークンがログ／fixtureに含まれない。
