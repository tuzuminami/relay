# 03. SyRS — システム要求仕様
    **参照:** ISO/IEC/IEEE 29148、品質特性はISO/IEC 25010を参照。

    ## 1. 機能要求
    | ID | 要求 | 受入条件 |
|---|---|---|
| FR-REL-001 | 統一されたChat/Stream/Embeddings/Tools契約でProvider Adapterを呼び出せる。 | Adapter間で共通必須フィールドと互換性エラーが明示される。 |
| FR-REL-002 | ModelRouteによりtenant、用途、データ分類、コスト上限でProviderを選択できる。 | Routeに適合しないRequestは外部Providerへ送信しない。 |
| FR-REL-003 | ストリーミング応答を中断・再接続・監査できる。 | 中断時はpartial出力と終了理由をクライアントへ返す。 |
| FR-REL-004 | Fallbackを冪等に実行し、二重課金・二重ツール実行を防ぐ。 | ToolCall開始後は代替Providerへの自動再送を禁止または明示確認にする。 |
| FR-REL-005 | SecretReferenceで認証情報を参照し、平文キーをログ・設定exportへ残さない。 | ログ検査でAPIキー形式が検出された場合はテストを失敗させる。 |
| FR-REL-006 | UsageRecordにtoken、latency、route、provider、cost estimate、trace IDを記録する。 | PII本文は既定でUsageRecordに保存しない。 |

    ## 2. 非機能要求
    | ID | 要求 | 受入条件 |
|---|---|---|
| NFR-001 | Tenant分離 | 全読取・更新・削除クエリにtenant_idが必須。越境試験は403または404。 |
| NFR-002 | 認証・認可 | 全変更APIでactorとscopeを検証。匿名変更を許可しない。 |
| NFR-003 | 可用性と縮退 | 外部依存のtimeoutは設定可能。安全上重要な依存失敗ではfail-closed。 |
| NFR-004 | 観測性 | 全HTTP要求・外部呼出し・状態遷移にcorrelation IDを付与。 |
| NFR-005 | 性能 | 標準的な同期APIは依存成功時p95 300ms以下を目標。重い処理は非同期ジョブ化。 |
| NFR-006 | 保守性 | domain / adapter / transportを分離し、依存方向をlintまたはarchitecture testで検証。 |
| NFR-007 | 移植性 | LinuxコンテナとPostgreSQLで稼働。クラウド固有SDKをcoreへ導入しない。 |
| NFR-008 | データ保護 | Secretをログ・例外・fixtureに出力しない。Sensitiveデータの保持期間を設定可能にする。 |

    ## 3. データ完全性要求
    - すべての変更可能リソースは`id`、`tenantId`、`createdAt`、`createdBy`、`version`を持つ。
    - 追記専用の監査イベントは物理更新を禁止し、訂正は後続イベントで表現する。
    - 楽観ロックまたはVersion条件を使い、lost updateを防止する。
    - request id / idempotency keyを受け付ける変更APIは、再送による副作用の重複を防止する。

    ## 4. セキュリティ要求
    - 認可前にデータ存在を詳細に漏らさない。
    - 監査ログは本文よりもID、ハッシュ、理由コードを優先する。
    - SecretはSecretReferenceで参照し、APIのGET／export対象から除外する。
    - 開発用seedデータは実在の個人情報を含めない。

    ## 5. 互換性要求
    - RESTは`/v1`で開始する。
    - 破壊的変更は新API versionまたは明示されたdeprecation期間を設ける。
    - Plugin SPIはcore APIと別のSemVer範囲で管理し、互換性テストを公開する。
